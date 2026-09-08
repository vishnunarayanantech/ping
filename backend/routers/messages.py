"""
Message endpoints: send a message into a conversation, and fetch a
conversation's history. Both require the caller to be a member of the
conversation — never assume a conversation_id means the caller has access.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from database import get_db
from models import Conversation, Message, User
from schemas import ConversationResponse, MessageCreate, MessageOut, SendMessageResponse
from security import get_current_user
from services.conversation_service import is_conversation_member

router = APIRouter(prefix="/messages", tags=["messages"])


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

    message = Message(conversation_id=payload.conversation_id, sender_id=current_user.id, content=content)
    db.add(message)

    conversation = db.query(Conversation).filter(Conversation.id == payload.conversation_id).first()
    conversation.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(message)

    return SendMessageResponse(success=True, message=MessageOut.model_validate(message))


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
    return ConversationResponse(success=True, messages=[MessageOut.model_validate(m) for m in messages])
