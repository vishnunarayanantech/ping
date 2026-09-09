"""
Forward-preview lookups for messages that reference another message via
forwarded_from_message_id, kept out of routers/messages.py so the route
handlers stay thin — same split as reply_service.py.
"""
from typing import Dict, List

from sqlalchemy.orm import Session

from models import Message, User
from schemas import ForwardPreview


def get_forward_previews_by_message(db: Session, messages: List[Message]) -> Dict[int, ForwardPreview]:
    """
    One ForwardPreview per message that has a forwarded_from_message_id, in a
    single query regardless of how many messages are passed in — same
    batching approach as reply_service.get_reply_previews_by_message. Keyed
    by the *forwarded* message's id, ready to attach straight onto each
    MessageOut.forwarded_from.
    """
    forward_ids = {m.forwarded_from_message_id for m in messages if m.forwarded_from_message_id is not None}
    if not forward_ids:
        return {}

    rows = (
        db.query(Message, User)
        .join(User, Message.sender_id == User.id)
        .filter(Message.id.in_(forward_ids))
        .all()
    )
    preview_by_original_id = {
        original.id: ForwardPreview(
            id=original.id,
            sender_id=original.sender_id,
            sender_name=sender.name,
            content=original.content,
        )
        for original, sender in rows
    }

    return {
        m.id: preview_by_original_id[m.forwarded_from_message_id]
        for m in messages
        if m.forwarded_from_message_id in preview_by_original_id
    }
