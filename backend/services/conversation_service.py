"""
Conversation business logic, kept out of routers/conversations.py so the
route handlers stay thin (auth, validation, response shaping only).
"""
from typing import Dict, List, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from models import Conversation, ConversationMember, Message, User


def get_or_create_direct_conversation(db: Session, user_a_id: int, user_b_id: int) -> Conversation:
    """
    Return the existing direct conversation between these two users, or
    create one. Guarantees at most one direct conversation ever exists
    between any given pair.

    Correctness note: this is the ONLY function that creates conversations
    or adds members, and it always creates exactly 2-member "direct" ones.
    So "a direct conversation where both A and B are members" is always
    exactly {A, B} — no separate "exactly 2 members" check is needed. That
    invariant breaks if a future feature (e.g. group chats) starts adding
    members through a different path; revisit this function first if so.
    """
    if user_a_id == user_b_id:
        raise ValueError("A direct conversation requires two different users")

    user_a_conversation_ids = db.query(ConversationMember.conversation_id).filter(
        ConversationMember.user_id == user_a_id
    )

    existing = (
        db.query(Conversation)
        .filter(Conversation.conversation_type == "direct")
        .filter(Conversation.id.in_(user_a_conversation_ids))
        .join(ConversationMember, ConversationMember.conversation_id == Conversation.id)
        .filter(ConversationMember.user_id == user_b_id)
        .first()
    )
    if existing:
        return existing

    conversation = Conversation(conversation_type="direct")
    db.add(conversation)
    db.flush()  # assigns conversation.id without committing yet

    db.add(ConversationMember(conversation_id=conversation.id, user_id=user_a_id))
    db.add(ConversationMember(conversation_id=conversation.id, user_id=user_b_id))
    db.commit()
    db.refresh(conversation)
    return conversation


def is_conversation_member(db: Session, conversation_id: int, user_id: int) -> bool:
    return (
        db.query(ConversationMember)
        .filter(ConversationMember.conversation_id == conversation_id)
        .filter(ConversationMember.user_id == user_id)
        .first()
        is not None
    )


def get_user_conversations(
    db: Session, user_id: int
) -> Tuple[List[Conversation], Dict[int, Message], Dict[int, User]]:
    """
    Everything the sidebar needs, in a fixed small number of queries
    regardless of how many messages exist — never loads every message
    into Python just to find the latest one per conversation.

    Returns (conversations sorted by most-recently-active, {conversation_id:
    latest Message}, {conversation_id: the other member's User}).
    """
    member_conversation_ids = db.query(ConversationMember.conversation_id).filter(
        ConversationMember.user_id == user_id
    )

    conversations = (
        db.query(Conversation)
        .filter(Conversation.id.in_(member_conversation_ids))
        .order_by(Conversation.updated_at.desc())
        .all()
    )

    if not conversations:
        return [], {}, {}

    conversation_ids = [c.id for c in conversations]

    # Latest message per conversation via a single grouped query (id is a
    # reliable tiebreaker — SQLite's timestamp resolution is coarse enough
    # that messages sent close together can share a created_at value).
    latest_ids_subquery = (
        db.query(Message.conversation_id, func.max(Message.id).label("latest_id"))
        .filter(Message.conversation_id.in_(conversation_ids))
        .group_by(Message.conversation_id)
        .subquery()
    )
    latest_messages = (
        db.query(Message).join(latest_ids_subquery, Message.id == latest_ids_subquery.c.latest_id).all()
    )
    latest_message_by_conversation = {m.conversation_id: m for m in latest_messages}

    # The other member of each (direct) conversation, in a single query.
    other_memberships = (
        db.query(ConversationMember)
        .filter(ConversationMember.conversation_id.in_(conversation_ids))
        .filter(ConversationMember.user_id != user_id)
        .all()
    )
    other_user_by_conversation = {m.conversation_id: m.user for m in other_memberships}

    return conversations, latest_message_by_conversation, other_user_by_conversation
