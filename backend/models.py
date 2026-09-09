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
