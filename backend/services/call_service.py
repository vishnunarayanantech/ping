"""
Call business logic: create/accept/reject/cancel/hang-up a one-to-one audio
call, busy/timeout enforcement, and signaling-message storage — kept out of
routers/calls.py so the route handlers stay thin (auth, validation, response
shaping only), same split as conversation_service.py / reaction_service.py.
"""
import json
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from config import CALL_RING_TIMEOUT_SECONDS
from models import Call, CallSignal, ConversationMember
from schemas import CallOut, UserOut

# A call is "in progress" — busy-checking and the incoming-call poll both key
# off this. Every other status ("rejected", "cancelled", "missed", "busy",
# "ended") is terminal.
ACTIVE_STATUSES = ("ringing", "accepted")


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def get_other_member_id(db: Session, conversation_id: int, user_id: int) -> Optional[int]:
    """The other participant of a direct conversation, or None if `user_id`
    somehow isn't a member of it (caller already checked membership before
    reaching here — see routers/calls.py) or the conversation has no other
    member yet."""
    membership = (
        db.query(ConversationMember)
        .filter(ConversationMember.conversation_id == conversation_id)
        .filter(ConversationMember.user_id != user_id)
        .first()
    )
    return membership.user_id if membership else None


def get_active_call_for_user(db: Session, user_id: int) -> Optional[Call]:
    """The one call (if any) this user is currently ringing/on — used both to
    enforce busy (a user can't be dialed, or dial out, while this returns
    non-None for them) and to let a receiver discover an incoming call via
    GET /calls/active."""
    return (
        db.query(Call)
        .filter(or_(Call.caller_id == user_id, Call.receiver_id == user_id))
        .filter(Call.status.in_(ACTIVE_STATUSES))
        .order_by(Call.id.desc())
        .first()
    )


def apply_ring_timeout(db: Session, call: Call) -> Call:
    """
    Lazily transitions a call stuck in "ringing" past CALL_RING_TIMEOUT_SECONDS
    into "missed" — checked on every read (GET /calls/{id}, GET /calls/active)
    and before every state-changing action (accept/reject), so a call whose
    recipient never answers reliably becomes "missed" with no background job
    or scheduler needed. Idempotent: once flipped, later calls just see
    status == "missed" and this is a no-op — so a client polling every couple
    of seconds never sees more than one transition, i.e. never creates more
    than one missed-call notification for the same call (see routers/calls.py).
    """
    if call.status != "ringing":
        return call
    age = datetime.now(timezone.utc) - _as_utc(call.created_at)
    if age > timedelta(seconds=CALL_RING_TIMEOUT_SECONDS):
        call.status = "missed"
        call.ended_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(call)
    return call


def create_call(db: Session, caller_id: int, receiver_id: int, conversation_id: int, call_type: str = "audio") -> Call:
    """
    Creates the call row. If either party is already on an active call, the
    row is created (per the task's data-model spec) but immediately
    finalized with status="busy" instead of "ringing" — it never rings the
    receiver and never appears in their GET /calls/active poll (that only
    looks at ACTIVE_STATUSES), so a busy attempt is invisible to them, not a
    missed-call notification. This check is the actual enforcement (routers/
    calls.py never takes the frontend's word for whether either side is free).

    call_type is already validated by schemas.CallCreate before reaching
    here — see models.Call's docstring for why it's fixed for the life of
    the row regardless of what either side's camera actually ends up doing.
    """
    busy = get_active_call_for_user(db, caller_id) is not None or get_active_call_for_user(db, receiver_id) is not None

    call = Call(
        conversation_id=conversation_id,
        caller_id=caller_id,
        receiver_id=receiver_id,
        status="busy" if busy else "ringing",
        call_type=call_type,
        ended_at=datetime.now(timezone.utc) if busy else None,
    )
    db.add(call)
    db.commit()
    db.refresh(call)
    return call


def accept_call(db: Session, call: Call) -> Call:
    call.status = "accepted"
    call.answered_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(call)
    return call


def reject_call(db: Session, call: Call) -> Call:
    call.status = "rejected"
    call.ended_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(call)
    return call


def cancel_call(db: Session, call: Call) -> Call:
    call.status = "cancelled"
    call.ended_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(call)
    return call


def end_call(db: Session, call: Call) -> Call:
    call.status = "ended"
    call.ended_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(call)
    return call


def add_signal(db: Session, call_id: int, sender_id: int, message_type: str, payload: dict) -> CallSignal:
    signal = CallSignal(call_id=call_id, sender_id=sender_id, message_type=message_type, payload=json.dumps(payload))
    db.add(signal)
    db.commit()
    db.refresh(signal)
    return signal


def get_new_signals(db: Session, call_id: int, current_user_id: int, after_id: int) -> List[CallSignal]:
    """Every signaling message on this call NOT sent by the caller of this
    function, with id > after_id — see models.CallSignal's docstring for why
    "not sent by me" is already an unambiguous "for me" in a 1:1 call."""
    return (
        db.query(CallSignal)
        .filter(CallSignal.call_id == call_id)
        .filter(CallSignal.sender_id != current_user_id)
        .filter(CallSignal.id > after_id)
        .order_by(CallSignal.id)
        .all()
    )


def to_call_out(call: Call) -> CallOut:
    return CallOut(
        id=call.id,
        conversation_id=call.conversation_id,
        status=call.status,
        call_type=call.call_type,
        caller=UserOut.model_validate(call.caller),
        receiver=UserOut.model_validate(call.receiver),
        created_at=call.created_at,
        answered_at=call.answered_at,
        ended_at=call.ended_at,
    )
