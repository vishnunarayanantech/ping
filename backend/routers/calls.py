"""
One-to-one audio call endpoints: create/accept/reject/cancel/hang-up a call,
poll its state, and relay WebRTC signaling messages (SDP offer/answer, ICE
candidates). REST/polling only for now — GET /calls/{call_id} is deliberately
shaped as "current state + everything new since after_signal_id" in one
response, the same shape a future WebSocket "call:update" event would push,
so replacing the transport later only touches calls.js's polling loop, never
the WebRTC layer itself (RTCPeerConnection handling stays exactly as-is).

Membership is the same access-control boundary as everywhere else in this
API: creating a call requires being a member of the (direct) conversation,
and every other action requires being that specific call's caller or
receiver — never trust a call_id in isolation. The callee is always derived
server-side from conversation membership (services/call_service.get_other_member_id),
never taken from the client, same "sender is always the verified token, never
the request body" rule auth.py/messages.py already follow. Busy and ring-
timeout are enforced here (and in call_service), never assumed from the
frontend's own state.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from config import get_ice_servers
from database import get_db
from models import Call, Conversation, User
from schemas import (
    CallActiveResponse,
    CallCreate,
    CallResponse,
    CallSignalCreate,
    CallSignalOut,
    CallStateResponse,
    IceServersResponse,
)
from security import get_current_user
from services import call_service
from services.conversation_service import is_conversation_member

router = APIRouter(prefix="/calls", tags=["calls"])


def _get_call_or_404(db: Session, call_id: int) -> Call:
    call = db.query(Call).filter(Call.id == call_id).first()
    if not call:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call not found")
    return call


def _require_participant(call: Call, user_id: int) -> None:
    # Deliberately a flat 403 regardless of whether call_id doesn't exist vs.
    # exists but this user isn't on it — handled by the 404 above already
    # running first, so this only ever fires for "exists but not yours",
    # same "don't let a client learn which is true" posture as the rest of
    # the API's membership checks.
    if user_id not in (call.caller_id, call.receiver_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this call")


@router.get("/ice-servers", response_model=IceServersResponse)
def ice_servers(current_user: User = Depends(get_current_user)):
    return IceServersResponse(success=True, ice_servers=get_ice_servers())


@router.get("/active", response_model=CallActiveResponse)
def get_active_call(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Polled while idle (no call currently on screen) to discover an incoming
    call — the receiver has no other way to learn a call_id exists. Also
    doubles as "resume the call I'm already on" if the page reloads mid-call.
    """
    call = call_service.get_active_call_for_user(db, current_user.id)
    if call:
        call = call_service.apply_ring_timeout(db, call)
        if call.status not in call_service.ACTIVE_STATUSES:
            call = None
    return CallActiveResponse(success=True, call=call_service.to_call_out(call) if call else None)


@router.post("", response_model=CallResponse, status_code=status.HTTP_201_CREATED)
def create_call(
    payload: CallCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not is_conversation_member(db, payload.conversation_id, current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this conversation")

    conversation = db.query(Conversation).filter(Conversation.id == payload.conversation_id).first()
    if not conversation or conversation.conversation_type != "direct":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Calls are only supported in direct conversations")

    receiver_id = call_service.get_other_member_id(db, payload.conversation_id, current_user.id)
    if receiver_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This conversation has no one else to call")

    call = call_service.create_call(db, current_user.id, receiver_id, payload.conversation_id)
    return CallResponse(success=True, call=call_service.to_call_out(call))


@router.get("/{call_id}", response_model=CallStateResponse)
def get_call(
    call_id: int,
    after_signal_id: int = 0,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_call_or_404(db, call_id)
    _require_participant(call, current_user.id)

    call = call_service.apply_ring_timeout(db, call)
    signals = call_service.get_new_signals(db, call_id, current_user.id, after_signal_id)

    return CallStateResponse(
        success=True,
        call=call_service.to_call_out(call),
        signals=[CallSignalOut.model_validate(s) for s in signals],
    )


@router.post("/{call_id}/signals", status_code=status.HTTP_201_CREATED)
def post_signal(
    call_id: int,
    payload: CallSignalCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_call_or_404(db, call_id)
    _require_participant(call, current_user.id)

    call = call_service.apply_ring_timeout(db, call)
    if call.status not in call_service.ACTIVE_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This call has already ended")

    call_service.add_signal(db, call_id, current_user.id, payload.message_type, payload.payload)
    return {"success": True}


@router.post("/{call_id}/accept", response_model=CallResponse)
def accept_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_call_or_404(db, call_id)
    if current_user.id != call.receiver_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the recipient can accept this call")

    call = call_service.apply_ring_timeout(db, call)
    if call.status != "ringing":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"This call is no longer available ({call.status})")

    call = call_service.accept_call(db, call)
    return CallResponse(success=True, call=call_service.to_call_out(call))


@router.post("/{call_id}/reject", response_model=CallResponse)
def reject_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_call_or_404(db, call_id)
    if current_user.id != call.receiver_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the recipient can reject this call")

    call = call_service.apply_ring_timeout(db, call)
    if call.status != "ringing":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"This call is no longer available ({call.status})")

    call = call_service.reject_call(db, call)
    return CallResponse(success=True, call=call_service.to_call_out(call))


@router.post("/{call_id}/cancel", response_model=CallResponse)
def cancel_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_call_or_404(db, call_id)
    if current_user.id != call.caller_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the caller can cancel this call")

    call = call_service.apply_ring_timeout(db, call)
    if call.status != "ringing":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"This call is no longer available ({call.status})")

    call = call_service.cancel_call(db, call)
    return CallResponse(success=True, call=call_service.to_call_out(call))


@router.post("/{call_id}/hangup", response_model=CallResponse)
def hangup_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_call_or_404(db, call_id)
    _require_participant(call, current_user.id)

    if call.status != "accepted":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"This call is no longer active ({call.status})")

    call = call_service.end_call(db, call)
    return CallResponse(success=True, call=call_service.to_call_out(call))
