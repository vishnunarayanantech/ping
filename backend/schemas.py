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


class UserRegister(BaseModel):
    name: str = Field(min_length=2)
    email: EmailStr
    password: str = Field(min_length=8)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: int
    name: str
    email: str

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


class MessageCreate(BaseModel):
    conversation_id: int
    content: str = Field(min_length=1, max_length=5000)
    reply_to_message_id: Optional[int] = None


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
