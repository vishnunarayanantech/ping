"""
Message endpoints: send a message into a conversation, fetch a
conversation's history (each message including its reaction summaries),
and add/remove the caller's own emoji reaction to a message. All four
require the caller to be a member of the message's conversation — never
assume a conversation_id/message_id alone means the caller has access.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from database import get_db
from models import Conversation, Message, User
from schemas import (
    ConversationResponse,
    MessageCreate,
    MessageOut,
    MessageReactionsResponse,
    ReactionCreate,
    ReplyPreview,
    SendMessageResponse,
)
from security import get_current_user
from services import reaction_service, reply_service
from services.conversation_service import is_conversation_member

router = APIRouter(prefix="/messages", tags=["messages"])


def _get_message_or_404(db: Session, message_id: int) -> Message:
    message = db.query(Message).filter(Message.id == message_id).first()
    if not message:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    return message


@router.post("", response_model=SendMessageResponse, status_code=status.HTTP_201_CREATED)
def send_message(
    payload: MessageCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Message content cannot be empty")

    if not is_conversation_member(db, payload.conversation_id, current_user.id):
        # Deliberately the same error for "doesn't exist" and "exists but
        # you're not a member" — don't let a client learn which is true.
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this conversation")

    reply_to = None
    if payload.reply_to_message_id is not None:
        reply_to = reply_service.get_reply_target(db, payload.reply_to_message_id, payload.conversation_id)
        if reply_to is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="The message being replied to doesn't exist in this conversation",
            )

    message = Message(
        conversation_id=payload.conversation_id,
        sender_id=current_user.id,
        content=content,
        reply_to_message_id=payload.reply_to_message_id,
    )
    db.add(message)

    conversation = db.query(Conversation).filter(Conversation.id == payload.conversation_id).first()
    conversation.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(message)

    message_out = MessageOut.model_validate(message)
    if reply_to is not None:
        message_out.reply_to = ReplyPreview(
            id=reply_to.id, sender_id=reply_to.sender_id, sender_name=reply_to.sender.name, content=reply_to.content
        )

    return SendMessageResponse(success=True, message=message_out)


@router.get("/conversation/{conversation_id}", response_model=ConversationResponse)
def get_conversation_messages(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not is_conversation_member(db, conversation_id, current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this conversation")

    messages = (
        db.query(Message)
        .filter(Message.conversation_id == conversation_id)
        # created_at alone isn't a stable sort key — SQLite's timestamp
        # resolution is coarse enough that rapid messages can share the
        # same value. id is monotonic and unique, so it breaks ties
        # deterministically (see conversation_service for the same trick).
        .order_by(Message.created_at, Message.id)
        .all()
    )

    reactions_by_message = reaction_service.get_reactions_by_message(
        db, [m.id for m in messages], current_user.id
    )
    reply_previews_by_message = reply_service.get_reply_previews_by_message(db, messages)
    message_outs = []
    for m in messages:
        message_out = MessageOut.model_validate(m)
        message_out.reactions = reactions_by_message.get(m.id, [])
        message_out.reply_to = reply_previews_by_message.get(m.id)
        message_outs.append(message_out)

    return ConversationResponse(success=True, messages=message_outs)


@router.post("/{message_id}/reactions", response_model=MessageReactionsResponse)
def add_reaction(
    message_id: int,
    payload: ReactionCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    message = _get_message_or_404(db, message_id)

    if not is_conversation_member(db, message.conversation_id, current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this conversation")

    reaction_service.add_reaction(db, message_id, current_user.id, payload.emoji)

    reactions = reaction_service.get_reactions_for_message(db, message_id, current_user.id)
    return MessageReactionsResponse(success=True, reactions=reactions)


@router.delete("/{message_id}/reactions/{emoji}", response_model=MessageReactionsResponse)
def remove_reaction(
    message_id: int,
    emoji: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    message = _get_message_or_404(db, message_id)

    if not is_conversation_member(db, message.conversation_id, current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this conversation")

    reaction_service.remove_reaction(db, message_id, current_user.id, emoji)

    reactions = reaction_service.get_reactions_for_message(db, message_id, current_user.id)
    return MessageReactionsResponse(success=True, reactions=reactions)
