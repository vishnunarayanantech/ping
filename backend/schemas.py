from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator


def _ensure_utc(value: datetime) -> datetime:
    """SQLite stores naive UTC timestamps. Stamp them as UTC explicitly so
    JSON responses are unambiguous and the frontend renders correct local
    times instead of misreading a naive string as already-local."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


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


class MessageOut(BaseModel):
    id: int
    conversation_id: int
    sender_id: int
    content: str
    created_at: datetime
    # Defaults to [] when the source object has no `.reactions` attribute at
    # all (a fresh Message from send_message, or model_validate on the ORM
    # row before reactions are attached) — see MessageReaction's docstring.
    reactions: List[ReactionSummary] = Field(default_factory=list)

    @field_validator("created_at")
    @classmethod
    def _created_at_utc(cls, value: datetime) -> datetime:
        return _ensure_utc(value)

    class Config:
        from_attributes = True


class SendMessageResponse(BaseModel):
    success: bool
    message: MessageOut


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
