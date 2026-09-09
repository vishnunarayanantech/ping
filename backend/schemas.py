import hashlib
from datetime import datetime, timezone
from typing import List, Optional

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
