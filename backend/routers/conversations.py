"""
Conversation endpoints: get-or-create a direct conversation with another
user, and list the current user's conversations for the sidebar.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import (
    ConversationListResponse,
    ConversationOut,
    ConversationSummary,
    CreateConversationResponse,
    LastMessagePreview,
    UserOut,
)
from security import get_current_user
from services.conversation_service import get_or_create_direct_conversation, get_user_conversations

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.post("/direct/{user_id}", response_model=CreateConversationResponse)
def create_or_get_direct_conversation(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You can't start a conversation with yourself")

    other_user = db.query(User).filter(User.id == user_id).first()
    if not other_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    conversation = get_or_create_direct_conversation(db, current_user.id, user_id)

    return CreateConversationResponse(
        success=True,
        conversation=ConversationOut(
            id=conversation.id,
            type=conversation.conversation_type,
            created_at=conversation.created_at,
        ),
    )


@router.get("", response_model=ConversationListResponse)
def list_conversations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conversations, latest_by_conversation, other_user_by_conversation = get_user_conversations(db, current_user.id)

    summaries = []
    for conversation in conversations:
        other_user = other_user_by_conversation.get(conversation.id)
        if other_user is None:
            # Shouldn't happen for a direct conversation, but don't let one
            # bad row break the whole sidebar.
            continue

        latest_message = latest_by_conversation.get(conversation.id)
        last_message_out = (
            LastMessagePreview(
                content=latest_message.content,
                sender_id=latest_message.sender_id,
                created_at=latest_message.created_at,
            )
            if latest_message
            else None
        )

        summaries.append(
            ConversationSummary(
                id=conversation.id,
                type=conversation.conversation_type,
                updated_at=conversation.updated_at,
                other_user=UserOut.model_validate(other_user),
                last_message=last_message_out,
            )
        )

    return ConversationListResponse(success=True, conversations=summaries)
