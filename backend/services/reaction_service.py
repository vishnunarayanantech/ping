"""
Message reaction business logic, kept out of routers/messages.py so the
route handlers stay thin (auth, validation, response shaping only) — same
split as conversation_service.py.
"""
from typing import Dict, List

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import MessageReaction, User
from schemas import ReactionSummary, ReactionUserOut


def add_reaction(db: Session, message_id: int, user_id: int, emoji: str) -> None:
    """
    Insert the reaction. Relies on the table's unique constraint (message_id,
    user_id, emoji) rather than a check-then-insert, so this stays correct
    under two near-simultaneous requests for the same reaction — the loser
    just hits IntegrityError, which is exactly the no-op this call should be
    ("one user, one reaction of a given emoji, per message").
    """
    db.add(MessageReaction(message_id=message_id, user_id=user_id, emoji=emoji))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()


def remove_reaction(db: Session, message_id: int, user_id: int, emoji: str) -> None:
    """Idempotent: a no-op if the user never reacted with this emoji."""
    db.query(MessageReaction).filter(
        MessageReaction.message_id == message_id,
        MessageReaction.user_id == user_id,
        MessageReaction.emoji == emoji,
    ).delete()
    db.commit()


def get_reactions_by_message(
    db: Session, message_ids: List[int], current_user_id: int
) -> Dict[int, List[ReactionSummary]]:
    """
    One reaction-summary list per message, in a single query regardless of
    how many messages are passed in — same batching approach as
    conversation_service.get_user_conversations. Aggregation happens in
    Python (not SQL group_by) because each summary needs the actual list of
    reactors, not just a count.
    """
    if not message_ids:
        return {}

    rows = (
        db.query(MessageReaction, User)
        .join(User, MessageReaction.user_id == User.id)
        .filter(MessageReaction.message_id.in_(message_ids))
        .order_by(MessageReaction.message_id, MessageReaction.created_at, MessageReaction.id)
        .all()
    )

    grouped: Dict[int, Dict[str, dict]] = {}
    for reaction, user in rows:
        by_emoji = grouped.setdefault(reaction.message_id, {})
        entry = by_emoji.setdefault(reaction.emoji, {"users": [], "reacted_by_me": False})
        entry["users"].append(ReactionUserOut(id=user.id, name=user.name))
        if user.id == current_user_id:
            entry["reacted_by_me"] = True

    return {
        message_id: [
            ReactionSummary(
                emoji=emoji, count=len(data["users"]), users=data["users"], reacted_by_me=data["reacted_by_me"]
            )
            for emoji, data in by_emoji.items()
        ]
        for message_id, by_emoji in grouped.items()
    }


def get_reactions_for_message(db: Session, message_id: int, current_user_id: int) -> List[ReactionSummary]:
    return get_reactions_by_message(db, [message_id], current_user_id).get(message_id, [])
