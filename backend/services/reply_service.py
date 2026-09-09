"""
Reply-preview lookups for messages that reference another message via
reply_to_message_id, kept out of routers/messages.py so the route handlers
stay thin — same split as conversation_service.py and reaction_service.py.
"""
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from models import Message, User
from schemas import ReplyPreview


def get_reply_target(db: Session, message_id: int, conversation_id: int) -> Optional[Message]:
    """
    Look up a message being replied to, scoped to `conversation_id` so a
    client can never make a message appear to quote something from a
    conversation it doesn't belong to. Returns None if the message doesn't
    exist or belongs to a different conversation — caller treats both as
    "invalid reply target" without distinguishing which (same reasoning as
    is_conversation_member's merged 403).
    """
    return (
        db.query(Message)
        .filter(Message.id == message_id, Message.conversation_id == conversation_id)
        .first()
    )


def get_reply_previews_by_message(db: Session, messages: List[Message]) -> Dict[int, ReplyPreview]:
    """
    One ReplyPreview per message that has a reply_to_message_id, in a single
    query regardless of how many messages are passed in — same batching
    approach as reaction_service.get_reactions_by_message. Keyed by the
    *replying* message's id (not the original's), ready to attach straight
    onto each MessageOut.reply_to.
    """
    reply_ids = {m.reply_to_message_id for m in messages if m.reply_to_message_id is not None}
    if not reply_ids:
        return {}

    rows = (
        db.query(Message, User)
        .join(User, Message.sender_id == User.id)
        .filter(Message.id.in_(reply_ids))
        .all()
    )
    preview_by_original_id = {
        original.id: ReplyPreview(
            id=original.id,
            sender_id=original.sender_id,
            sender_name=sender.name,
            content=original.content,
        )
        for original, sender in rows
    }

    return {
        m.id: preview_by_original_id[m.reply_to_message_id]
        for m in messages
        if m.reply_to_message_id in preview_by_original_id
    }
