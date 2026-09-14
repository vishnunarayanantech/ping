"""
One-to-one audio/video call endpoints: create/accept/reject/cancel/hang-up a call,
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

from config import GROUP_CALL_MAX_PARTICIPANTS, get_ice_servers
from database import get_db
from models import Call, Conversation, User
from schemas import (
    CallActiveResponse,
    CallCreate,
    CallResponse,
    CallSignalCreate,
    CallSignalOut,
    CallStateResponse,
    GroupCallActiveResponse,
    GroupCallCreate,
    GroupCallResponse,
    GroupCallStateResponse,
    IceServersResponse,
)
from security import get_current_user
from services import call_service
from services.conversation_service import has_direct_conversation, is_conversation_member

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

    call = call_service.create_call(db, current_user.id, receiver_id, payload.conversation_id, payload.call_type)
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


# --- Group audio calling -----------------------------------------------------
# A separate set of routes rather than overloading the direct-call ones
# above: a group call has no single "receiver" to accept/reject/cancel, and
# "hang up" splits into two distinct, differently-authorized actions (leave
# vs. end for everyone) — see services/call_service's group-call docstrings.
# Every route below only ever reads/writes scope="group" Call rows and
# CallParticipant rows; nothing above this line was touched, so the direct-
# call routes keep behaving exactly as before.


def _get_group_call_or_404(db: Session, call_id: int) -> Call:
    call = db.query(Call).filter(Call.id == call_id, Call.scope == "group").first()
    if not call:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call not found")
    return call


def _require_group_access(db: Session, call_id: int, user_id: int):
    """Flat 403 for anyone with no live stake in this call — never invited,
    already left, or (implicitly, via the 404 above running first) a
    nonexistent/non-group call id. Same "don't let a client learn which is
    true" posture as _require_participant above."""
    participant = call_service.get_group_call_participant(db, call_id, user_id)
    if not participant or participant.status not in ("invited", "joined"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this call")
    return participant


@router.post("/group", response_model=GroupCallResponse, status_code=status.HTTP_201_CREATED)
def create_group_call(
    payload: GroupCallCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not is_conversation_member(db, payload.conversation_id, current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this conversation")

    conversation = db.query(Conversation).filter(Conversation.id == payload.conversation_id).first()
    if not conversation or conversation.conversation_type != "direct":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Group calls must be started from a direct conversation"
        )

    other_member_id = call_service.get_other_member_id(db, payload.conversation_id, current_user.id)
    if other_member_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This conversation has no one else to call")

    # Explicitly selected extra invitees — see schemas.GroupCallCreate's
    # docstring for why this, not "every member of a group conversation", is
    # PING's group-call membership source: conversations here are always
    # exactly 2 people, so there's no bigger membership list to draw from.
    extra_ids = set(payload.participant_ids)
    extra_ids.discard(current_user.id)
    extra_ids.discard(other_member_id)

    if extra_ids:
        existing_ids = {u.id for u in db.query(User).filter(User.id.in_(extra_ids)).all()}
        missing_ids = extra_ids - existing_ids
        if missing_ids:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="One or more selected users don't exist")

        # Never let a group call reach an arbitrary user id — each extra
        # invitee must already be a contact (an existing direct conversation
        # with the creator), same "never trust a caller-supplied target"
        # rule this whole router already follows, applied to a LIST instead
        # of a single receiver_id this time.
        non_contact_ids = {uid for uid in extra_ids if not has_direct_conversation(db, current_user.id, uid)}
        if non_contact_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You can only add people you already have a conversation with",
            )

    try:
        call = call_service.create_group_call(db, current_user.id, payload.conversation_id, other_member_id, extra_ids)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    return GroupCallResponse(success=True, call=call_service.to_group_call_out(call))


@router.get("/group/active", response_model=GroupCallActiveResponse)
def get_active_group_call(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Polled while idle to discover an incoming group-call invitation, or to
    resume one already joined after a page reload — the group equivalent of
    GET /calls/active above."""
    call = call_service.get_active_group_call_for_user(db, current_user.id)
    return GroupCallActiveResponse(success=True, call=call_service.to_group_call_out(call) if call else None)


@router.get("/group/{call_id}", response_model=GroupCallStateResponse)
def get_group_call(
    call_id: int,
    after_signal_id: int = 0,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_group_call_or_404(db, call_id)
    _require_group_access(db, call_id, current_user.id)

    signals = call_service.get_new_group_signals(db, call_id, current_user.id, after_signal_id)
    return GroupCallStateResponse(
        success=True,
        call=call_service.to_group_call_out(call),
        signals=[CallSignalOut.model_validate(s) for s in signals],
    )


@router.post("/group/{call_id}/join", response_model=GroupCallResponse)
def join_group_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_group_call_or_404(db, call_id)
    if call.status != call_service.GROUP_ACTIVE_STATUS:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This group call has already ended")

    participant = _require_group_access(db, call_id, current_user.id)

    if participant.status != "joined":
        # Defense in depth — the roster is already capped at creation time
        # (services/call_service.create_group_call), so this only matters if
        # participants rejoin/leave in ways that could otherwise let a call
        # exceed the limit; belt-and-suspenders, not the primary enforcement.
        joined_count = sum(1 for p in call.participants if p.status == "joined")
        if joined_count >= GROUP_CALL_MAX_PARTICIPANTS:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This group call is full")

    call = call_service.join_group_call(db, call, participant)
    return GroupCallResponse(success=True, call=call_service.to_group_call_out(call))


@router.post("/group/{call_id}/leave", response_model=GroupCallResponse)
def leave_group_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_group_call_or_404(db, call_id)
    participant = call_service.get_group_call_participant(db, call_id, current_user.id)
    if not participant or participant.status != "joined":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You aren't in this call")

    call = call_service.leave_group_call(db, call, participant)
    return GroupCallResponse(success=True, call=call_service.to_group_call_out(call))


@router.post("/group/{call_id}/end", response_model=GroupCallResponse)
def end_group_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Ends the call for EVERYONE. Restricted to the call's creator — a
    group call's roster has no other role that implies this level of
    authority the way a direct call's caller/receiver both naturally can
    hang up on each other; see services/call_service.end_group_call's
    docstring. Anyone else who wants out uses .../leave instead, which never
    affects other participants."""
    call = _get_group_call_or_404(db, call_id)
    if current_user.id != call.caller_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the call's creator can end it for everyone")
    if call.status != call_service.GROUP_ACTIVE_STATUS:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This group call has already ended")

    call = call_service.end_group_call(db, call)
    return GroupCallResponse(success=True, call=call_service.to_group_call_out(call))


@router.post("/group/{call_id}/signals", status_code=status.HTTP_201_CREATED)
def post_group_signal(
    call_id: int,
    payload: CallSignalCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = _get_group_call_or_404(db, call_id)
    if call.status != call_service.GROUP_ACTIVE_STATUS:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This group call has already ended")

    sender = call_service.get_group_call_participant(db, call_id, current_user.id)
    if not sender or sender.status != "joined":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You aren't in this call")

    if payload.peer_user_id is not None:
        # Never let a client route SDP/ICE to an unrelated connection — the
        # target must be a CURRENT (joined) participant of this SAME call,
        # not just any user id the client happens to send.
        target = call_service.get_group_call_participant(db, call_id, payload.peer_user_id)
        if not target or target.status != "joined":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That participant isn't in this call")
    elif payload.message_type != "mute-state":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="peer_user_id is required for this signal type")

    call_service.add_signal(db, call_id, current_user.id, payload.message_type, payload.payload, payload.peer_user_id)
    return {"success": True}
