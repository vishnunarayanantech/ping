from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # Editable via PUT /users/profile — see routers/users.py. Nullable so
    # ALTER TABLE ADD COLUMN (main.py's _add_missing_columns) doesn't need a
    # server-side default for existing rows; routers/users.py treats NULL
    # the same as "" when building the response.
    job_title = Column(String, nullable=True, default="")
    department = Column(String, nullable=True, default="")
    # Server-generated at registration (routers/auth.py) and never editable
    # by the client — see schemas.ProfileUpdate, which deliberately has no
    # field for this.
    employee_id = Column(String, unique=True, index=True, nullable=True)
    # Relative to config.AVATAR_DIR (not absolute), same "relative so the
    # upload directory can move between environments" reasoning as
    # MessageFile.file_path. NULL means "no avatar uploaded" — routers/users.py
    # and schemas.build_avatar_url both treat that as "show the default
    # initials avatar" rather than a broken image. Set only via
    # POST /users/profile/avatar — see services/avatar_service.py.
    avatar_path = Column(String, nullable=True)


class Conversation(Base):
    """
    A conversation is just a container for members + messages.
    conversation_type is "direct" for now — future values ("group",
    "channel") are what this table exists to make easy to add later.
    Only direct (exactly 2-member) conversations are created today; see
    services/conversation_service.py.
    """

    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    conversation_type = Column(String, nullable=False, default="direct")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), index=True)

    members = relationship("ConversationMember", back_populates="conversation", cascade="all, delete-orphan")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")


class ConversationMember(Base):
    __tablename__ = "conversation_members"
    __table_args__ = (UniqueConstraint("conversation_id", "user_id", name="uq_conversation_member"),)

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    joined_at = Column(DateTime(timezone=True), server_default=func.now())
    # NULL means "never read this conversation" — every message in it is
    # unread. Set to the conversation's latest message timestamp (not
    # just "now") when the member reads it; see mark_conversation_read().
    last_read_at = Column(DateTime(timezone=True), nullable=True)

    conversation = relationship("Conversation", back_populates="members")
    user = relationship("User")


class Message(Base):
    """A single message. Belongs to one conversation and one sender."""

    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=False, index=True)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    # NULL for an ordinary message. When set, points at another message in
    # the SAME conversation this one is replying to — routers/messages.py
    # enforces that same-conversation rule at write time, since a bare FK
    # can't express it. No ORM relationship on purpose: schemas.ReplyPreview
    # needs the original sender's *name*, not the raw row, so it's built
    # explicitly in services/reply_service.py — same reasoning as
    # MessageReaction's docstring above.
    reply_to_message_id = Column(Integer, ForeignKey("messages.id"), nullable=True, index=True)
    # NULL for a message that wasn't forwarded. When set, points at the
    # message this one was forwarded from — deliberately UNSCOPED to any
    # particular conversation (unlike reply_to_message_id above), since
    # forwarding's whole point is crossing from a source conversation into a
    # different target one. routers/messages.py checks the caller is a member
    # of the source message's conversation before allowing the forward, but
    # that source can be any conversation the two happen to share. Same "no
    # ORM relationship" reasoning as reply_to_message_id: schemas.ForwardPreview
    # needs the original sender's name, built explicitly in
    # services/forward_service.py.
    forwarded_from_message_id = Column(Integer, ForeignKey("messages.id"), nullable=True, index=True)
    # NULL for a message that's never been edited — the frontend shows the
    # plain send time for those. Set to the edit's server time whenever the
    # sender updates `content` via PUT /messages/{id} (routers/messages.py),
    # which is also the ONLY thing that ever writes this column or `content`
    # after creation. created_at is deliberately left untouched by an edit so
    # the original send time always survives — see chat.js's "Edited · <time>"
    # rendering, which reads created_at for the time and edited_at only to
    # decide whether to show that prefix.
    edited_at = Column(DateTime(timezone=True), nullable=True)

    conversation = relationship("Conversation", back_populates="messages")
    sender = relationship("User")


class MessageReaction(Base):
    """
    One user's emoji reaction to one message. No `reactions` back_populates on
    Message on purpose: schemas.MessageOut has its own `reactions` field shaped
    as aggregated summaries (emoji/count/users/reacted_by_me), not raw rows, so
    it's built explicitly in services/reaction_service.py rather than through
    an ORM relationship — from_attributes validation would otherwise try to
    coerce these raw rows straight into that summary shape and fail.
    """

    __tablename__ = "message_reactions"
    __table_args__ = (UniqueConstraint("message_id", "user_id", "emoji", name="uq_message_reaction"),)

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    emoji = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    user = relationship("User")


class MessageFile(Base):
    """
    The uploaded-file attachment for a file-share message. Every file
    upload creates its OWN Message (see services/file_service.py) — there's
    no "attach a file to an existing text message" path — so this is a 1:1
    relationship with Message, enforced by the unique constraint below.

    file_path is stored RELATIVE to config.UPLOAD_DIR (not absolute), so
    the upload directory can move between environments without a data
    migration. stored_filename is a UUID-based name that never collides and
    never echoes anything the client sent; original_filename is display-only
    (see services/file_service.py for the sanitization that makes it safe to
    show back to users and hand out in a Content-Disposition header). No
    ORM relationship back on Message on purpose — same reasoning as
    MessageReaction's docstring above: schemas.MessageOut.file is built
    explicitly in routers/messages.py, not through from_attributes coercion.
    """

    __tablename__ = "message_files"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False, unique=True, index=True)
    original_filename = Column(String, nullable=False)
    stored_filename = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    mime_type = Column(String, nullable=False)
    file_size = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Call(Base):
    """
    One 1:1 audio or video call attempt. Always scoped to a direct conversation —
    receiver_id is never taken from the client, it's derived server-side from
    that conversation's OTHER member (see services/call_service.py), the same
    "never trust a caller-supplied target id" rule every other endpoint here
    follows.

    status is the whole state machine: "ringing" (just created, either party
    can still act on it) -> exactly one of "accepted" (see answered_at),
    "rejected", "cancelled", or "missed" (services/call_service.apply_ring_timeout
    lazily flips a stale "ringing" call to this on read — no scheduler needed).
    An "accepted" call ends in "ended". "busy" is a terminal status set at
    creation time when the caller or receiver was already on another active
    call — that row is finalized immediately (ended_at set) rather than ever
    being "ringing", so it never rings the would-be receiver and never shows
    up in their incoming-call poll (see get_active_call_for_user).

    No ORM relationship back from Conversation/User on purpose — a call isn't
    part of a conversation's message history and doesn't belong on a User the
    way, say, Message.sender does.

    call_type is "audio" or "video" (see schemas.CALL_TYPES), fixed once at
    creation time from whichever button the caller used and never changed
    after. It reflects the CALLER's side only — if the receiver's own camera
    then fails to acquire, they still negotiate audio-only media over the
    same call_type="video" row (see calls.js's downgrade handling) rather
    than flipping this back to "audio". Defaults to "audio" so every call row
    that predates this column reads as exactly what it always was.

    scope is "direct" (the original 1:1 shape above, every column meaning
    exactly what its docstring says) or "group" (see services/call_service's
    group-call functions and CallParticipant below). Added additively —
    every pre-existing row is backfilled to "direct" (see main.py's
    _add_missing_columns) so nothing about direct calling changes meaning.

    For a scope="group" row: caller_id is the call's CREATOR (same column,
    reused rather than duplicated — a group call's creator plays the same
    "who started this" role caller_id already has). call_type is always
    "audio" (schemas.GroupCallCreate never accepts "video" — see the group
    calling task's explicit "audio-only" scope). receiver_id has no
    meaningful "other party" to hold — a group call, by definition, doesn't
    have exactly one — but the column is NOT NULL and changing that would
    mean rebuilding the table (SQLite can't ALTER a column's nullability in
    place), which is a bigger risk than it's worth for a column group calls
    simply don't use. So it's set equal to caller_id: a harmless, always-
    valid self-reference that every existing "receiver: UserOut" reader
    still resolves fine, and that to_group_call_out never surfaces (group
    responses carry a `participants` list from CallParticipant instead).
    status for scope="group" uses its own two-value vocabulary ("active",
    "ended") that never collides with the direct-call vocabulary above —
    see call_service.ACTIVE_STATUSES, which group rows never match, so
    every existing direct-call query (get_active_call_for_user, the busy
    check, etc.) keeps working completely unchanged with no explicit
    `scope` filter needed.
    """

    __tablename__ = "calls"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=False, index=True)
    caller_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    receiver_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String, nullable=False, default="ringing", index=True)
    call_type = Column(String, nullable=False, default="audio")
    scope = Column(String, nullable=False, default="direct", index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    answered_at = Column(DateTime(timezone=True), nullable=True)
    ended_at = Column(DateTime(timezone=True), nullable=True)
    # Group calls only (scope="group") — the ONE participant currently
    # sharing their screen, or NULL if nobody is. This is the same kind of
    # server-authoritative state CallParticipant.status already is for the
    # roster: every participant's poll response (see
    # services/call_service.to_group_call_out's `screen_share` field)
    # reconciles against THIS column, never trusting any one client's own
    # "am I sharing" belief. One-at-a-time is enforced by
    # services/call_service.start_group_screen_share (a ValueError, turned
    # into a 409, if this is already set to someone ELSE) — the actual
    # authorization boundary; the frontend disabling its own Share Screen
    # button while someone else shares is just a UI convenience on top of
    # this. Cleared on an explicit stop, on that participant leaving
    # (voluntarily or via the pagehide/keepalive path — see
    # leave_group_call), and unconditionally when the call ends for everyone
    # (see end_group_call) — so it can never keep pointing at someone no
    # longer in the call. Always NULL for scope="direct" rows: a 1:1 call's
    # screen sharing has no "who out of several" ambiguity to arbitrate
    # server-side, so it stays tracked entirely client-side via the existing
    # 'screen-share-state' signal (see schemas.CALL_SIGNAL_TYPES's
    # docstring).
    screen_sharing_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    # Read-only convenience relationships (no cascade, no back_populates) so
    # services/call_service.to_call_out can build the CallOut's nested
    # caller/receiver UserOut straight from the row without a second query.
    caller = relationship("User", foreign_keys=[caller_id])
    receiver = relationship("User", foreign_keys=[receiver_id])
    # Group calls only (scope="group") — every invited/joined/left user, one
    # row per user. No cascade here on purpose, same "read-only convenience"
    # reasoning as caller/receiver above; participants are only ever written
    # through services/call_service's group-call functions.
    participants = relationship("CallParticipant", back_populates="call")
    # Read-only convenience relationship for screen_sharing_user_id above,
    # same "avoid a second query in to_group_call_out" reasoning as
    # caller/receiver.
    screen_sharing_user = relationship("User", foreign_keys=[screen_sharing_user_id])


class CallSignal(Base):
    """
    One WebRTC signaling message (SDP offer/answer or an ICE candidate)
    exchanged during a call. payload is the signaling data as a JSON string
    (never parsed/interpreted server-side — this is a dumb relay, same
    "backend never touches the media" boundary as the rest of the calling
    feature) — schemas.CallSignalOut parses it back to a dict on the way out.

    No `to_user_id` column: every DIRECT call is exactly two participants, so
    "every signal not sent by me" (services/call_service.get_new_signals
    filters on sender_id != current_user.id) is already an unambiguous "for
    me" for scope="direct" calls — get_new_signals is never used for group
    calls, which need a real recipient column instead (see below).

    peer_user_id is that column, added additively for group calls only —
    always NULL for a direct-call signal (get_new_signals never looks at
    it), and always set for a group-call offer/answer/ice-candidate signal
    (see call_service.get_new_group_signals, which filters on it instead of
    the "everyone but me" rule above, since a group call has more than one
    "everyone else"). The one group signal type that's a broadcast rather
    than point-to-point — "mute-state" (schemas.CALL_SIGNAL_TYPES) — uses
    peer_user_id=NULL deliberately, meaning "every current/future
    participant", not "nobody in particular".
    """

    __tablename__ = "call_signaling"

    id = Column(Integer, primary_key=True, index=True)
    call_id = Column(Integer, ForeignKey("calls.id"), nullable=False, index=True)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    peer_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    message_type = Column(String, nullable=False)
    payload = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class CallParticipant(Base):
    """
    One user's membership in one GROUP call (scope="group" on Call above) —
    direct calls have no rows here at all, since caller_id/receiver_id on
    Call already say everything a 2-person call needs to. This is the
    authoritative roster a group call's join/leave/signal-routing endpoints
    check against: a user with no row (or a row whose status has already
    moved to "left") for a given call_id simply isn't part of it, the same
    "never trust a client-supplied participant" rule routers/calls.py
    already applies to direct calls via _require_participant.

    status starts "invited" (set for everyone except the creator when
    services/call_service.create_group_call creates the call — the creator's
    own row starts "joined"), moves to "joined" when that user actually
    calls POST /calls/group/{id}/join, and to "left" when they leave
    (voluntarily via POST .../leave, because the creator ended the call for
    everyone via POST .../end, or because
    services/call_service.apply_group_call_abandonment lazily reaped a
    "joined" row whose last_activity_at went stale — see that column's own
    docstring). There's no "declined" — an invited user who never joins just
    stays "invited" for the life of the call; nothing times that out the way
    a direct call's "ringing" does, since a group call has no single person
    whose non-answer should end it for everyone else.

    last_activity_at is bumped to "now" every time this participant's own
    client proves it's still around — set on join (create_group_call/
    join_group_call) and touched on every active-call poll (GET
    /calls/group/{id}, once _require_group_access confirms they're still a
    live participant). A page REFRESH is deliberately never treated as
    leaving (there's no unload handler calling .../leave any more — see
    groupcalls.js's module docstring) since refresh and a real tab-close are
    indistinguishable at the browser-event level; instead, this timestamp
    going stale past config.GROUP_CALL_ABANDON_TIMEOUT_SECONDS is what
    apply_group_call_abandonment uses to eventually free a truly-abandoned
    roster slot, the same "lazy check on read, no scheduler needed" pattern
    services/call_service.apply_ring_timeout already established for a
    direct call's ring timeout. NULL only ever transiently, between a row's
    creation and its first join/poll.
    """

    __tablename__ = "call_participants"
    __table_args__ = (UniqueConstraint("call_id", "user_id", name="uq_call_participant"),)

    id = Column(Integer, primary_key=True, index=True)
    call_id = Column(Integer, ForeignKey("calls.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String, nullable=False, default="invited", index=True)
    joined_at = Column(DateTime(timezone=True), nullable=True)
    left_at = Column(DateTime(timezone=True), nullable=True)
    last_activity_at = Column(DateTime(timezone=True), nullable=True)

    call = relationship("Call", back_populates="participants")
    user = relationship("User")
