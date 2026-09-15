import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, EmailStr, Field, computed_field, field_validator


def _ensure_utc(value: datetime) -> datetime:
    """SQLite stores naive UTC timestamps. Stamp them as UTC explicitly so
    JSON responses are unambiguous and the frontend renders correct local
    times instead of misreading a naive string as already-local."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


# MIME types that are technically "image/*" but capable of carrying active
# content (SVG can embed <script>) — excluded from inline preview out of an
# abundance of caution even though <img> already disables SVG scripting;
# there's no functional need to preview them inline, so there's no reason to
# take the risk. Category, not access — these still download like any file.
_UNSAFE_INLINE_IMAGE_MIME_TYPES = {"image/svg+xml"}


def _categorize_mime_type(mime_type: str) -> str:
    """
    Maps a message file's SERVER-DERIVED mime_type (see
    services/file_service.py — never the client's claimed Content-Type) to
    the coarse category the frontend uses to decide whether to render an
    inline preview at all: "image" | "video" | "audio" | "other". Prefix-
    based on purpose — the task calls for previewing "other safely
    supported" formats too, not just a fixed list, and a mistaken/malicious
    category is safe by construction anyway: <img>/<video>/<audio> never
    execute their src's bytes as anything other than that media type, so a
    wrongly-categorized file just fails to render (see MessageFileOut.category's
    "gracefully fall back" contract) rather than doing anything unsafe.
    """
    if mime_type in _UNSAFE_INLINE_IMAGE_MIME_TYPES:
        return "other"
    if mime_type.startswith("image/"):
        return "image"
    if mime_type.startswith("video/"):
        return "video"
    if mime_type.startswith("audio/"):
        return "audio"
    return "other"


def build_avatar_url(user_id: int, avatar_path: Optional[str]) -> Optional[str]:
    """None when the user has no avatar — the frontend (avatars.js) falls
    back to the initials avatar for that case. Otherwise a path to
    GET /users/{id}/avatar, relative to API_BASE_URL same as every other
    frontend request. Versioned with a short hash of the server-side
    storage path — never the path itself, same "client has no business
    seeing storage-layer details" reasoning as MessageFileOut excluding
    file_path/stored_filename — purely so a replaced avatar's URL changes
    and naturally busts the frontend's blob cache (see avatars.js), with no
    extra "avatar_updated_at" column needed."""
    if not avatar_path:
        return None
    version = hashlib.sha256(avatar_path.encode()).hexdigest()[:12]
    return f"/users/{user_id}/avatar?v={version}"


class UserRegister(BaseModel):
    name: str = Field(min_length=2)
    email: EmailStr
    password: str = Field(min_length=8)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    # avatar_path is populated straight from the ORM row (from_attributes
    # matches it by name) but never itself serialized — see
    # build_avatar_url's docstring. It only exists here to feed the
    # avatar_url computed_field below.
    id: int
    name: str
    email: str
    avatar_path: Optional[str] = Field(default=None, exclude=True)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def avatar_url(self) -> Optional[str]:
        return build_avatar_url(self.id, self.avatar_path)

    class Config:
        from_attributes = True


class AuthResponse(BaseModel):
    """Response envelope for registration (and the base shape login extends)."""

    success: bool
    message: str
    user: Optional[UserOut] = None


class LoginResponse(AuthResponse):
    """Login additionally returns a JWT the frontend attaches to future requests."""

    access_token: str


class UserSearchResponse(BaseModel):
    success: bool
    users: List[UserOut]


class UserProfileOut(BaseModel):
    """The full profile shown on profile.html — a superset of UserOut, kept
    as its own schema (rather than adding fields to UserOut) so the other
    endpoints that return UserOut (search results, message senders) don't
    start exposing job_title/department/employee_id for every user, not
    just the caller. Built explicitly from a User row in routers/users.py
    rather than via from_attributes, since the field names here
    (full_name/company_email) intentionally don't match the model's
    (name/email)."""

    id: int
    full_name: str
    job_title: str
    department: str
    company_email: str
    employee_id: str
    avatar_url: Optional[str] = None


class ProfileUpdate(BaseModel):
    """PUT /users/profile body. Deliberately has no field for company_email,
    employee_id, or user_id — the target user is always the JWT-authenticated
    caller (see routers/users.py's use of get_current_user), never a
    client-supplied id, and the two read-only fields simply have no way to
    reach the model no matter what a request body contains."""

    full_name: str = Field(max_length=100)
    job_title: str = Field(default="", max_length=100)
    department: str = Field(default="", max_length=100)

    class Config:
        extra = "forbid"

    @field_validator("full_name")
    @classmethod
    def _full_name_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if len(stripped) < 2:
            raise ValueError("must be at least 2 characters")
        return stripped

    @field_validator("job_title", "department")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()


class ProfileResponse(BaseModel):
    success: bool
    message: str
    profile: UserProfileOut


class MessageCreate(BaseModel):
    conversation_id: int
    content: str = Field(min_length=1, max_length=5000)
    reply_to_message_id: Optional[int] = None


class MessageUpdate(BaseModel):
    """PUT /messages/{message_id} body. `extra = "forbid"` is a deliberate
    belt-and-suspenders alongside routers/messages.py's ownership check —
    content is the only field a client can ever supply here, so there's no
    body shape that could smuggle a sender_id/conversation_id/created_at/
    reply_to_message_id/forwarded_from_message_id/id change through, same
    reasoning as ProfileUpdate's docstring."""

    content: str = Field(min_length=1, max_length=5000)

    class Config:
        extra = "forbid"


# The picker only ever offers these — restricting the backend to the same set
# keeps a direct API call from stuffing arbitrary text into what's rendered
# (and displayed back to every conversation member) as an "emoji".
ALLOWED_REACTION_EMOJIS = {"👍", "❤️", "😂", "😮", "😢", "😡", "🎉", "👏"}


class ReactionCreate(BaseModel):
    emoji: str

    @field_validator("emoji")
    @classmethod
    def _emoji_allowed(cls, value: str) -> str:
        if value not in ALLOWED_REACTION_EMOJIS:
            raise ValueError("Unsupported emoji")
        return value


class ReactionUserOut(BaseModel):
    id: int
    name: str

    class Config:
        from_attributes = True


class ReactionSummary(BaseModel):
    """One emoji's aggregated state on a message — what the picker/pill UI needs
    to render count, tooltip, and whether to show the "mine" highlight."""

    emoji: str
    count: int
    users: List[ReactionUserOut]
    reacted_by_me: bool


class MessageReactionsResponse(BaseModel):
    success: bool
    reactions: List[ReactionSummary]


class ReplyPreview(BaseModel):
    """The compact quoted-message info a reply's UI needs — not the full
    MessageOut shape, since it's only ever rendered as a one-line quote,
    never as a message in its own right here."""

    id: int
    sender_id: int
    sender_name: str
    content: str

    class Config:
        from_attributes = True


class ForwardPreview(BaseModel):
    """The compact original-message info a forwarded message's UI needs —
    same shape and reasoning as ReplyPreview, just sourced from
    forwarded_from_message_id instead of reply_to_message_id."""

    id: int
    sender_id: int
    sender_name: str
    content: str

    class Config:
        from_attributes = True


class MessageFileOut(BaseModel):
    """The file-share info a file message's UI needs — file_path and
    stored_filename deliberately excluded, since those are storage-layer
    details the client has no business seeing (and shouldn't need, since
    downloading/viewing always goes through /messages/files/{id}/download)."""

    id: int
    original_filename: str
    mime_type: str
    file_size: int
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def _created_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def category(self) -> str:
        """"image" | "video" | "audio" | "other" — derived fresh from
        mime_type on every serialization rather than stored, so it can never
        drift out of sync with the field it's derived from. chat.js uses
        this alone to decide whether to attempt an inline preview at all;
        see _categorize_mime_type's docstring for why a wrong guess here is
        safe, not just convenient."""
        return _categorize_mime_type(self.mime_type)

    class Config:
        from_attributes = True


class MessageOut(BaseModel):
    id: int
    conversation_id: int
    sender_id: int
    content: str
    created_at: datetime
    # NULL until the sender edits this message (PUT /messages/{id}) — see
    # models.Message.edited_at's docstring. Populated straight off the ORM
    # column like created_at, no service lookup needed.
    edited_at: Optional[datetime] = None
    reply_to_message_id: Optional[int] = None
    # Populated only when reply_to_message_id is set — see
    # services/reply_service.py. None both for ordinary messages and for a
    # reply whose original message no longer resolves.
    reply_to: Optional[ReplyPreview] = None
    forwarded_from_message_id: Optional[int] = None
    # Populated only when forwarded_from_message_id is set — see
    # services/forward_service.py.
    forwarded_from: Optional[ForwardPreview] = None
    # Defaults to [] when the source object has no `.reactions` attribute at
    # all (a fresh Message from send_message, or model_validate on the ORM
    # row before reactions are attached) — see MessageReaction's docstring.
    reactions: List[ReactionSummary] = Field(default_factory=list)
    # Populated only for a file-share message (one created via
    # POST /messages/upload) — see services/file_service.py.
    file: Optional[MessageFileOut] = None

    @field_validator("created_at")
    @classmethod
    def _created_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)

    @field_validator("edited_at")
    @classmethod
    def _edited_at_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        return _ensure_utc(value) if value is not None else None

    class Config:
        from_attributes = True


class SendMessageResponse(BaseModel):
    success: bool
    message: MessageOut


class ForwardMessageCreate(BaseModel):
    # Capped at 50 — a generous fan-out for a "forward to a few chats" action
    # without leaving an unbounded list for a client to send.
    conversation_ids: List[int] = Field(min_length=1, max_length=50)


class ForwardMessageResponse(BaseModel):
    success: bool
    # One new message per target conversation, in the same order as the
    # request's conversation_ids (after de-duplication).
    messages: List[MessageOut]


class ConversationResponse(BaseModel):
    success: bool
    messages: List[MessageOut]


class ConversationOut(BaseModel):
    id: int
    type: str
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def _created_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)


class CreateConversationResponse(BaseModel):
    success: bool
    conversation: ConversationOut


class LastMessagePreview(BaseModel):
    content: str
    sender_id: int
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def _created_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)


class ConversationSummary(BaseModel):
    id: int
    type: str
    updated_at: datetime
    other_user: UserOut
    last_message: Optional[LastMessagePreview] = None
    unread_count: int = 0

    @field_validator("updated_at")
    @classmethod
    def _updated_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)


class ConversationListResponse(BaseModel):
    success: bool
    conversations: List[ConversationSummary]


class MarkReadResponse(BaseModel):
    success: bool
    message: str


# --- Calling (audio/video) -------------------------------------------------

# The only two kinds of call this app creates — see models.Call's docstring
# for why call_type is fixed at creation and never changes afterward.
CALL_TYPES = {"audio", "video"}


class CallCreate(BaseModel):
    """POST /calls body. Deliberately has no receiver_id field — the callee
    is always derived server-side from the conversation's OTHER member (see
    routers/calls.py), never taken from the client, same reasoning as
    ProfileUpdate/MessageUpdate's docstrings for why their schemas omit
    fields that would let a request body name a different target.

    call_type defaults to "audio" so older frontend code (or any direct API
    caller) that never sends it still gets exactly the old behavior."""

    conversation_id: int
    call_type: str = "audio"

    @field_validator("call_type")
    @classmethod
    def _valid_call_type(cls, value: str) -> str:
        if value not in CALL_TYPES:
            raise ValueError("Unsupported call type")
        return value


class CallOut(BaseModel):
    id: int
    conversation_id: int
    status: str
    call_type: str
    caller: UserOut
    receiver: UserOut
    created_at: datetime
    answered_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None

    @field_validator("created_at")
    @classmethod
    def _created_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)

    @field_validator("answered_at", "ended_at")
    @classmethod
    def _optional_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        return _ensure_utc(value) if value is not None else None

    class Config:
        from_attributes = True


class CallResponse(BaseModel):
    success: bool
    call: CallOut


class CallActiveResponse(BaseModel):
    """GET /calls/active — call is None when the caller has no ringing/
    accepted call to resume or answer right now."""

    success: bool
    call: Optional[CallOut] = None


# The only WebRTC/call-UI signaling message shapes this feature ever relays —
# restricting the backend to this set is the same "don't let a direct API
# call smuggle arbitrary content through" reasoning as
# schemas.ALLOWED_REACTION_EMOJIS. "camera-state" and "screen-share-state" are
# the two non-WebRTC entries: disabling a local video track (see calls.js's
# toggleCamera) or stopping a screen-share track (see calls.js's
# stopScreenShare) doesn't reliably surface as the browser's native
# track-muted event on the OTHER side (some engines just send black frames
# instead of actually pausing the RTP stream), so each needs its own
# explicit, trivial message over this SAME relay rather than a new channel.
# "offer"/"answer" already cover renegotiation too (e.g. adding the
# screen-share video track to an established audio call) — calls.js tells
# the two apart by whether the peer connection already has a remote
# description, not by a distinct signal type, so no new type was needed for
# that part.
#
# "mute-state" (group calls only — see groupcalls.js) is the group
# equivalent of "camera-state": MediaStreamTrack.enabled on a mic track
# doesn't reliably surface as the remote side's native track-muted event
# either, same reasoning models.CallSignal's peer_user_id docstring gives —
# so mute needs its own explicit signal too. Sent with peer_user_id=None
# (broadcast to every participant) rather than once per peer, since one
# user's mute state is the same fact for everybody in the call, not a
# pairwise negotiation like offer/answer/ice-candidate are.
#
# "screen-share-state" is ALSO sent broadcast (peer_user_id=None) for a
# group call — routers/calls.py's post_group_signal allows it alongside
# "mute-state" for that reason. Unlike mute-state, it is NOT the
# authoritative "who is sharing" fact for a group call — that's
# models.Call.screen_sharing_user_id, reconciled every poll via
# GroupCallOut.screen_share (see start_group_screen_share/
# stop_group_screen_share) — this signal exists purely so the OTHER
# participants' viewers update the instant the sharer toggles, without
# waiting out a poll tick, same as it already does for a 1:1 call's single
# other party.
#
# "camera-state" is used TWO different ways depending on scope: for a
# DIRECT call it's still point-to-point (peer_user_id implied — there's only
# one other party). For a GROUP call it's ALSO allowed broadcast
# (peer_user_id=None), joining mute-state/screen-share-state above — unlike
# screen sharing, camera has no server-side exclusivity to be authoritative
# about (any number of participants may have a camera on at once, so there's
# no models.Call column for it), so the broadcast signal (reconciled by every
# participant's groupcalls.js into that peer's own participant-map entry) is
# the ONLY "is this participant's camera currently on" fact a group call
# has — the underlying WebRTC video track's own liveness can't serve that
# role, since replaceTrack(null) (how a group participant turns their camera
# back off — see groupcalls.js's stopLocalCameraTracks) leaves the remote
# side's already-negotiated track object sitting at readyState "live"
# indefinitely rather than ending it.
CALL_SIGNAL_TYPES = {"offer", "answer", "ice-candidate", "camera-state", "screen-share-state", "mute-state"}


class CallSignalCreate(BaseModel):
    """POST /calls/{call_id}/signals (direct) or
    POST /calls/group/{call_id}/signals (group) body. `payload` is passed
    through to the recipient(s) completely opaque to the backend (it's
    SDP/ICE data meant for the browser's WebRTC stack, never interpreted
    server-side) — see models.CallSignal's docstring.

    peer_user_id is group-calls-only: which OTHER participant this signal is
    for (routers/calls.py validates both sender and target are current
    participants of the same call before storing it), or None for a
    broadcast "mute-state" signal. Always None/omitted for a direct-call
    signal — get_new_signals never reads it, so it's simply unused there,
    same as every direct-call row already has scope="direct" and no
    CallParticipant rows.
    """

    message_type: str
    payload: Dict[str, Any]
    peer_user_id: Optional[int] = None

    @field_validator("message_type")
    @classmethod
    def _valid_message_type(cls, value: str) -> str:
        if value not in CALL_SIGNAL_TYPES:
            raise ValueError("Unsupported signal type")
        return value


class CallSignalOut(BaseModel):
    id: int
    sender_id: int
    message_type: str
    payload: Dict[str, Any]
    created_at: datetime

    @field_validator("payload", mode="before")
    @classmethod
    def _parse_payload(cls, value):
        # ORM rows store payload as a JSON string (models.CallSignal.payload
        # is a Text column) — parse it back to a dict here so this schema can
        # validate straight off the row via from_attributes, same as every
        # other *Out schema in this file.
        if isinstance(value, str):
            return json.loads(value)
        return value

    @field_validator("created_at")
    @classmethod
    def _created_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)

    class Config:
        from_attributes = True


class CallStateResponse(BaseModel):
    """GET /calls/{call_id} — the call's current status plus any signaling
    messages from the OTHER participant the caller hasn't seen yet (see
    services/call_service.get_new_signals). One poll response carries both,
    which is deliberately shaped like a single WebSocket "call update" event
    would be — see routers/calls.py's module docstring for why."""

    success: bool
    call: CallOut
    signals: List[CallSignalOut] = Field(default_factory=list)


class IceServersResponse(BaseModel):
    success: bool
    ice_servers: List[Dict[str, str]]


# --- Calling (group audio) --------------------------------------------------
# A separate section rather than folding into CallCreate/CallOut above: a
# group call's shape (a creator plus a roster of N participants, no single
# "receiver") is different enough from a direct call's that reusing the same
# schemas would mean making half their fields optional/meaningless for one
# scope or the other. See models.Call's scope docstring for how the two
# share the same underlying table without either one's meaning drifting.


class GroupCallCreate(BaseModel):
    """POST /calls/group body. conversation_id must be a direct conversation
    the caller belongs to (same membership check as CallCreate) — its OTHER
    member is always included automatically, mirroring the existing "call
    button in this chat's header calls the person you're chatting with"
    convention. participant_ids are ADDITIONAL people to invite, explicitly
    selected by the creator — see routers/calls.py's eligibility check
    (each one must already share a direct conversation with the creator,
    i.e. already be a "contact", never an arbitrary company-wide user id).
    The max_length here is just a generous sanity bound on the request body
    itself; the real, authoritative participant-count limit
    (config.GROUP_CALL_MAX_PARTICIPANTS) is enforced in
    services/call_service.create_group_call against the deduplicated total
    including the creator and the conversation's other member."""

    conversation_id: int
    participant_ids: List[int] = Field(default_factory=list, max_length=20)


class AddGroupCallParticipantsCreate(BaseModel):
    """POST /calls/group/{call_id}/participants body — the mid-call "Add
    People" counterpart to GroupCallCreate.participant_ids above, for a call
    that's already active. Deliberately UNLIKE participant_ids above: those
    extra invitees must already be a "contact" (has_direct_conversation) of
    the creator, but user_ids here has no such restriction — the frontend's
    picker is the existing COMPANY-WIDE user search (GET /users/search, the
    same one the sidebar's "start a new conversation" uses), not the
    creator's own conversation list, so any registered user is a valid
    candidate here. routers/calls.py still independently verifies each one
    exists, isn't already an active (invited/joined) participant, and that
    the resulting roster wouldn't exceed config.GROUP_CALL_MAX_PARTICIPANTS
    — this schema only bounds the request body's own shape."""

    user_ids: List[int] = Field(min_length=1, max_length=20)


class GroupCallParticipantOut(BaseModel):
    user: UserOut
    status: str  # invited | joined | left
    joined_at: Optional[datetime] = None
    left_at: Optional[datetime] = None

    @field_validator("joined_at", "left_at")
    @classmethod
    def _optional_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        return _ensure_utc(value) if value is not None else None


class GroupScreenShareOut(BaseModel):
    """Who is currently sharing their screen in a group call — absent
    (GroupCallOut.screen_share is None) when nobody is. Sourced straight
    from models.Call.screen_sharing_user_id, the server-authoritative slot
    services/call_service.start_group_screen_share enforces one-at-a-time —
    never a client's own belief about who's sharing."""

    user: UserOut


class GroupCallOut(BaseModel):
    id: int
    conversation_id: int
    creator: UserOut
    call_type: str
    status: str  # active | ended
    created_at: datetime
    ended_at: Optional[datetime] = None
    participants: List[GroupCallParticipantOut] = Field(default_factory=list)
    screen_share: Optional[GroupScreenShareOut] = None

    @field_validator("created_at")
    @classmethod
    def _created_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)

    @field_validator("ended_at")
    @classmethod
    def _ended_at_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        return _ensure_utc(value) if value is not None else None


class GroupCallResponse(BaseModel):
    success: bool
    call: GroupCallOut


class GroupCallActiveResponse(BaseModel):
    """GET /calls/group/active — call is None when the caller has no active
    group call (invited or already joined) to resume or answer right now."""

    success: bool
    call: Optional[GroupCallOut] = None


class GroupCallStateResponse(BaseModel):
    """GET /calls/group/{call_id} — same "current state + everything new
    since after_signal_id in one response" shape as CallStateResponse, see
    its docstring."""

    success: bool
    call: GroupCallOut
    signals: List[CallSignalOut] = Field(default_factory=list)
