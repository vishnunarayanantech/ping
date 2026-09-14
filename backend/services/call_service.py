"""
Call business logic: create/accept/reject/cancel/hang-up a one-to-one audio
call, busy/timeout enforcement, and signaling-message storage — kept out of
routers/calls.py so the route handlers stay thin (auth, validation, response
shaping only), same split as conversation_service.py / reaction_service.py.
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Iterable, List, Optional

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from config import CALL_RING_TIMEOUT_SECONDS, GROUP_CALL_ABANDON_TIMEOUT_SECONDS, GROUP_CALL_MAX_PARTICIPANTS
from models import Call, CallParticipant, CallSignal, ConversationMember
from schemas import CallOut, GroupCallOut, GroupCallParticipantOut, GroupScreenShareOut, UserOut

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


def add_signal(
    db: Session, call_id: int, sender_id: int, message_type: str, payload: dict, peer_user_id: Optional[int] = None
) -> CallSignal:
    """peer_user_id defaults to None (direct calls never pass it — see
    models.CallSignal's docstring) so this same function serves both direct
    signaling (routers/calls.py's post_signal) and group signaling
    (post_group_signal) without duplicating the insert."""
    signal = CallSignal(
        call_id=call_id, sender_id=sender_id, peer_user_id=peer_user_id, message_type=message_type,
        payload=json.dumps(payload),
    )
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


# --- Group audio calling ----------------------------------------------------
# Kept in this same module (not a separate service file) since it's the same
# "call" concept and the same Call table — see models.Call's scope docstring
# — just a different shape of participant. Every function below only ever
# touches scope="group" rows; nothing above this line was changed to make
# room for them, so direct calling's behavior is unaffected by construction,
# not just by convention.

# A group call's own two-value status vocabulary — deliberately disjoint
# from ACTIVE_STATUSES above (a group call is never "ringing"/"accepted"/
# etc.), so a group row can never be mistaken for an active DIRECT call by
# any of the functions above, with no explicit `scope` filter needed there.
GROUP_ACTIVE_STATUS = "active"
GROUP_ENDED_STATUS = "ended"


def create_group_call(
    db: Session, creator_id: int, conversation_id: int, other_member_id: int, extra_participant_ids: Iterable[int]
) -> Call:
    """
    Creates the group-call session row plus one CallParticipant per invitee.
    The creator's own row starts "joined" (they're in the call the instant
    they create it); everyone else starts "invited" — see
    models.CallParticipant's docstring.

    other_member_id (the direct conversation's other member, resolved by the
    caller — routers/calls.py — via the same get_other_member_id direct
    calls already use) is always included, mirroring the existing "the call
    button in this chat calls the person you're chatting with" convention.
    extra_participant_ids are whoever the creator explicitly picked on top
    of that — routers/calls.py has already checked each one is an existing
    contact (has_direct_conversation) before this runs; this function only
    owns the count limit and the actual writes.

    Raises ValueError (caught by routers/calls.py and turned into a 400) if
    the deduplicated roster — creator + other_member + extras — would exceed
    config.GROUP_CALL_MAX_PARTICIPANTS. No Call/CallParticipant row is
    created in that case, per the task's "existing call remains intact"
    requirement for the participant-limit test — there's nothing to roll
    back because nothing is written until after this check passes.
    """
    invitee_ids = {other_member_id, *extra_participant_ids}
    invitee_ids.discard(creator_id)  # the creator can't "invite" themselves

    total_participants = len(invitee_ids) + 1  # +1 for the creator
    if total_participants > GROUP_CALL_MAX_PARTICIPANTS:
        raise ValueError(f"Group calls are limited to {GROUP_CALL_MAX_PARTICIPANTS} participants (including you).")

    now = datetime.now(timezone.utc)
    call = Call(
        conversation_id=conversation_id,
        caller_id=creator_id,
        receiver_id=creator_id,  # see models.Call's scope docstring — unused for group calls
        status=GROUP_ACTIVE_STATUS,
        call_type="audio",
        scope="group",
    )
    db.add(call)
    db.flush()  # assigns call.id without committing yet, so participant rows below can reference it

    db.add(CallParticipant(call_id=call.id, user_id=creator_id, status="joined", joined_at=now, last_activity_at=now))
    for user_id in invitee_ids:
        db.add(CallParticipant(call_id=call.id, user_id=user_id, status="invited"))

    db.commit()
    db.refresh(call)
    return call


def add_group_call_participants(db: Session, call: Call, user_ids: Iterable[int]) -> Call:
    """
    Invites `user_ids` into an ALREADY ACTIVE group call — the mid-call "Add
    People" counterpart to create_group_call above. routers/calls.py has
    already checked every id is a real user and none is currently an active
    (invited/joined) participant — using a query result it read a moment
    earlier. This function deliberately re-reads both the roster count AND
    each target's current CallParticipant row itself, right before writing,
    rather than trusting that earlier read: two participants clicking "Add
    People" for different people at nearly the same instant is exactly the
    kind of race the router's own pre-check can't fully close (task's
    "two existing participants simultaneously try to add people" scenario),
    so the authoritative check happens as close to the write as this
    codebase's plain check-then-write style (same as every other cap check
    here — see create_group_call/join_group_call) reasonably allows.

    Someone who previously LEFT this same call (a row exists with
    status="left") is reactivated back to "invited" rather than getting a
    second row — the uq_call_participant constraint forbids a second row
    for the same call+user, and re-inviting a former participant is exactly
    what should happen here anyway.

    Raises ValueError — turned into a 409 by routers/calls.py (a live
    roster is something OTHER requests can change concurrently, unlike
    create_group_call's own cap ValueError, which stays a 400 since that's
    a single atomic creation with nothing to race against) — if the
    resulting roster would exceed config.GROUP_CALL_MAX_PARTICIPANTS, OR if
    a concurrent identical request won the race for one of these same
    user_ids (caught via IntegrityError on the unique constraint) —
    "conflict, nothing written, try again" either way. No row is written in
    either case: the count check runs before any write, and the race case
    rolls back whatever this call's own attempt had staged.
    """
    user_ids = set(user_ids)

    existing_rows = {
        p.user_id: p
        for p in db.query(CallParticipant)
        .filter(CallParticipant.call_id == call.id)
        .filter(CallParticipant.user_id.in_(user_ids))
        .all()
    }
    already_active = {uid for uid, p in existing_rows.items() if p.status in ("invited", "joined")}
    if already_active:
        raise ValueError("One or more selected people are already in this call.")

    current_count = (
        db.query(CallParticipant)
        .filter(CallParticipant.call_id == call.id)
        .filter(CallParticipant.status.in_(("invited", "joined")))
        .count()
    )
    new_count = sum(1 for uid in user_ids if uid not in existing_rows)
    if current_count + new_count > GROUP_CALL_MAX_PARTICIPANTS:
        raise ValueError(f"Group calls are limited to {GROUP_CALL_MAX_PARTICIPANTS} participants.")

    for user_id in user_ids:
        row = existing_rows.get(user_id)
        if row:
            row.status = "invited"
            row.left_at = None
        else:
            db.add(CallParticipant(call_id=call.id, user_id=user_id, status="invited"))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ValueError("One or more selected people were just added to this call.")

    db.refresh(call)
    return call


def get_group_call_participant(db: Session, call_id: int, user_id: int) -> Optional[CallParticipant]:
    return (
        db.query(CallParticipant)
        .filter(CallParticipant.call_id == call_id)
        .filter(CallParticipant.user_id == user_id)
        .first()
    )


def get_active_group_call_for_user(db: Session, user_id: int) -> Optional[Call]:
    """The one active group call (if any) this user currently has a live
    stake in — invited (not yet joined, i.e. an incoming notification) or
    already joined (e.g. resuming after a page reload) — used by
    GET /calls/group/active, the group equivalent of get_active_call_for_user
    above."""
    return (
        db.query(Call)
        .join(CallParticipant, CallParticipant.call_id == Call.id)
        .filter(Call.scope == "group")
        .filter(Call.status == GROUP_ACTIVE_STATUS)
        .filter(CallParticipant.user_id == user_id)
        .filter(CallParticipant.status.in_(("invited", "joined")))
        .order_by(Call.id.desc())
        .first()
    )


def join_group_call(db: Session, call: Call, participant: CallParticipant) -> Call:
    now = datetime.now(timezone.utc)
    participant.status = "joined"
    participant.joined_at = now
    participant.last_activity_at = now
    db.commit()
    db.refresh(call)
    return call


def touch_group_call_participant(db: Session, participant: CallParticipant) -> None:
    """Bumps last_activity_at to "now" — called once per active-call poll
    (see routers/calls.py's get_group_call) as this participant's own "I'm
    still here" signal, the thing apply_group_call_abandonment below checks
    against. Never called for a merely-"invited" participant — an
    un-joined invitee isn't occupying a live connection the way a "joined"
    one is, so it has no liveness to track."""
    participant.last_activity_at = datetime.now(timezone.utc)
    db.commit()


def _mark_participant_left(db: Session, call: Call, participant: CallParticipant, now: datetime) -> None:
    """Shared by leave_group_call (one explicit departure) and
    apply_group_call_abandonment (a lazy sweep over possibly several stale
    participants) — flips one participant to "left", releases their screen-
    share slot if they held it, and auto-ends the call if nobody's left
    "joined" (see models.CallParticipant's docstring: nothing else would
    ever end an abandoned group call otherwise, since ending is otherwise
    restricted to the creator — see end_group_call). Does NOT commit — the
    caller commits once after marking everyone in this pass, and decides
    whether to db.refresh(call) afterward."""
    participant.status = "left"
    participant.left_at = now
    if call.screen_sharing_user_id == participant.user_id:
        # The leaver was mid-share (voluntary leave, or lazily reaped after
        # going stale) — never leave the slot pointing at someone no longer
        # in the call; see models.Call.screen_sharing_user_id's docstring.
        call.screen_sharing_user_id = None
    db.flush()

    still_joined = (
        db.query(CallParticipant)
        .filter(CallParticipant.call_id == call.id)
        .filter(CallParticipant.status == "joined")
        .first()
    )
    if not still_joined:
        call.status = GROUP_ENDED_STATUS
        call.ended_at = now


def leave_group_call(db: Session, call: Call, participant: CallParticipant) -> Call:
    """Marks just this one participant as left — the call stays "active" for
    everyone else, UNLESS this was the last "joined" participant, in which
    case the call auto-ends. See _mark_participant_left for the shared
    logic — this is its "one explicit departure, commit once" caller."""
    _mark_participant_left(db, call, participant, datetime.now(timezone.utc))
    db.commit()
    db.refresh(call)
    return call


def apply_group_call_abandonment(db: Session, call: Call) -> Call:
    """
    Lazily flips any "joined" participant whose last_activity_at has gone
    stale past config.GROUP_CALL_ABANDON_TIMEOUT_SECONDS to "left" —
    checked on every read of an active group call (GET /calls/group/{id},
    GET /calls/group/active), the same "no background job or scheduler
    needed" pattern apply_ring_timeout already established for a direct
    call's ring timeout. This is what eventually frees a roster slot from
    someone who genuinely closed their tab: a page refresh no longer POSTs
    .../leave on unload (see groupcalls.js's module docstring), so without
    this, an abandoned "joined" row would otherwise sit there forever.
    Idempotent and a no-op (no commit) if nothing is stale.
    """
    if call.status != GROUP_ACTIVE_STATUS:
        return call

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=GROUP_CALL_ABANDON_TIMEOUT_SECONDS)
    stale = [
        p for p in call.participants
        if p.status == "joined" and (p.last_activity_at is None or _as_utc(p.last_activity_at) < cutoff)
    ]
    if not stale:
        return call

    now = datetime.now(timezone.utc)
    for participant in stale:
        _mark_participant_left(db, call, participant, now)

    db.commit()
    db.refresh(call)
    return call


def end_group_call(db: Session, call: Call) -> Call:
    """Ends the call for EVERYONE — only the creator may call this (enforced
    in routers/calls.py, the same "flat 403 for anyone else" posture direct
    calls use for their own role-gated actions). Every still-"joined"
    participant is flipped to "left" so their own next poll sees both
    call.status == "ended" and their own participant row already reflecting
    it — see the group-calling task's "all participants are notified through
    polling" requirement."""
    now = datetime.now(timezone.utc)
    call.status = GROUP_ENDED_STATUS
    call.ended_at = now
    call.screen_sharing_user_id = None  # the call is ending entirely — nothing left to point at
    (
        db.query(CallParticipant)
        .filter(CallParticipant.call_id == call.id)
        .filter(CallParticipant.status == "joined")
        .update({"status": "left", "left_at": now}, synchronize_session=False)
    )
    db.commit()
    db.refresh(call)
    return call


def start_group_screen_share(db: Session, call: Call, user_id: int) -> Call:
    """Claims the call's one screen-share slot for `user_id` — the
    authoritative state every participant's next poll (to_group_call_out's
    `screen_share` field) reconciles against, not just a same-shape signal
    like mute-state (see models.Call.screen_sharing_user_id's docstring).
    Idempotent if `user_id` already holds it (e.g. a retried request);
    raises ValueError — turned into a 409 by routers/calls.py — if someone
    ELSE currently does. This IS the one-at-a-time enforcement; the
    frontend disabling its own Share Screen button while someone else
    shares is just a UI convenience on top of it."""
    if call.screen_sharing_user_id is not None and call.screen_sharing_user_id != user_id:
        raise ValueError("Someone else is already sharing their screen")
    call.screen_sharing_user_id = user_id
    db.commit()
    db.refresh(call)
    return call


def stop_group_screen_share(db: Session, call: Call) -> Call:
    """Clears the active sharer unconditionally — routers/calls.py has
    already checked the caller either IS that sharer or that this is the
    leave/end path clearing it on someone else's behalf (see
    leave_group_call/end_group_call above), so this function just performs
    the write. A no-op (no commit) if nobody is currently sharing, so
    calling it twice in a row is harmless."""
    if call.screen_sharing_user_id is not None:
        call.screen_sharing_user_id = None
        db.commit()
        db.refresh(call)
    return call


def get_new_group_signals(db: Session, call_id: int, current_user_id: int, after_id: int) -> List[CallSignal]:
    """Every signal on this GROUP call meant for `current_user_id` — either
    targeted at them directly (peer_user_id == them, an offer/answer/
    ice-candidate from one specific other participant) or broadcast to
    everyone (peer_user_id IS NULL, i.e. a "mute-state" signal) — with
    id > after_id, same incremental-poll shape get_new_signals uses for
    direct calls. Never returns a signal this user sent themselves, same
    "not an echo of my own signal" rule get_new_signals already follows."""
    return (
        db.query(CallSignal)
        .filter(CallSignal.call_id == call_id)
        .filter(CallSignal.sender_id != current_user_id)
        .filter(or_(CallSignal.peer_user_id == current_user_id, CallSignal.peer_user_id.is_(None)))
        .filter(CallSignal.id > after_id)
        .order_by(CallSignal.id)
        .all()
    )


def to_group_call_out(call: Call) -> GroupCallOut:
    participants = [
        GroupCallParticipantOut(
            user=UserOut.model_validate(p.user),
            status=p.status,
            joined_at=p.joined_at,
            left_at=p.left_at,
        )
        for p in call.participants
    ]
    screen_share = (
        GroupScreenShareOut(user=UserOut.model_validate(call.screen_sharing_user))
        if call.screen_sharing_user_id is not None
        else None
    )
    return GroupCallOut(
        id=call.id,
        conversation_id=call.conversation_id,
        creator=UserOut.model_validate(call.caller),
        call_type=call.call_type,
        status=call.status,
        created_at=call.created_at,
        ended_at=call.ended_at,
        participants=participants,
        screen_share=screen_share,
    )
