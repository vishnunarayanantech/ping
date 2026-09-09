"""
Message endpoints: send a message into a conversation, edit one of the
caller's own messages in place, fetch a conversation's history (each
message including its reaction summaries), add/remove the caller's own
emoji reaction to a message, forward a message into one or more other
conversations, and upload/download file-share messages. Sending/fetching/
reacting/forwarding/uploading are gated on conversation membership — never
assume a conversation_id/message_id alone means the caller has access.
Editing is gated on message ownership instead (see edit_message) — a
conversation member who isn't the original sender must never be able to
change another member's message.
"""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from config import MAX_UPLOAD_SIZE_MB
from database import get_db
from models import Conversation, Message, MessageFile, User
from schemas import (
    ConversationResponse,
    ForwardMessageCreate,
    ForwardMessageResponse,
    ForwardPreview,
    MessageCreate,
    MessageFileOut,
    MessageOut,
    MessageReactionsResponse,
    MessageUpdate,
    ReactionCreate,
    ReplyPreview,
    SendMessageResponse,
)
from security import get_current_user
from services import file_service, forward_service, reaction_service, reply_service
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


@router.put("/{message_id}", response_model=SendMessageResponse)
def edit_message(
    message_id: int,
    payload: MessageUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Edit a message's content in place — same row, same id, same created_at.
    Ownership (not conversation membership) is the access-control boundary
    here: only the original sender may ever call this, since only the
    sender is even allowed to have something to say about their own
    message's wording. MessageUpdate.Config.extra="forbid" already keeps
    sender_id/conversation_id/created_at/reply_to_message_id/
    forwarded_from_message_id/id out of the request body entirely; this is
    the check that keeps another member of the same conversation from
    editing someone else's message by calling the endpoint directly.
    """
    message = _get_message_or_404(db, message_id)

    if message.sender_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only edit your own messages")

    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Message content cannot be empty")

    message.content = content
    message.edited_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(message)

    # Same reactions/reply_to/forwarded_from/file attachment as
    # get_conversation_messages below, just for the one edited row, so the
    # frontend can drop this straight into state.messages in place without
    # losing anything already showing on that row.
    message_out = MessageOut.model_validate(message)
    message_out.reactions = reaction_service.get_reactions_for_message(db, message.id, current_user.id)
    message_out.reply_to = reply_service.get_reply_previews_by_message(db, [message]).get(message.id)
    message_out.forwarded_from = forward_service.get_forward_previews_by_message(db, [message]).get(message.id)
    message_file = file_service.get_file_for_message(db, message.id)
    if message_file:
        message_out.file = MessageFileOut.model_validate(message_file)

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
    forward_previews_by_message = forward_service.get_forward_previews_by_message(db, messages)
    files_by_message = file_service.get_files_by_message(db, [m.id for m in messages])
    message_outs = []
    for m in messages:
        message_out = MessageOut.model_validate(m)
        message_out.reactions = reactions_by_message.get(m.id, [])
        message_out.reply_to = reply_previews_by_message.get(m.id)
        message_out.forwarded_from = forward_previews_by_message.get(m.id)
        message_out.file = files_by_message.get(m.id)
        message_outs.append(message_out)

    return ConversationResponse(success=True, messages=message_outs)


@router.post("/upload", response_model=SendMessageResponse, status_code=status.HTTP_201_CREATED)
async def upload_file(
    conversation_id: int = Form(...),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not is_conversation_member(db, conversation_id, current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this conversation")

    try:
        message = await file_service.save_message_file(db, conversation_id, current_user.id, file)
    except file_service.UploadRejected as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.message)
    except file_service.UploadTooLarge:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {MAX_UPLOAD_SIZE_MB:.0f} MB limit",
        )

    message_file = file_service.get_file_for_message(db, message.id)
    message_out = MessageOut.model_validate(message)
    message_out.file = MessageFileOut.model_validate(message_file)

    return SendMessageResponse(success=True, message=message_out)


@router.get("/files/{file_id}/download")
def download_file(
    file_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    message_file = db.query(MessageFile).filter(MessageFile.id == file_id).first()
    if not message_file:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    # Membership is checked against the file's OWNING message's conversation
    # — the same "conversation_id alone never grants access" rule as every
    # other endpoint here, just reached via message_id -> conversation_id.
    message = _get_message_or_404(db, message_file.message_id)
    if not is_conversation_member(db, message.conversation_id, current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this file")

    absolute_path = file_service.resolve_absolute_path(message_file.file_path)
    if not absolute_path or not os.path.isfile(absolute_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(absolute_path, media_type=message_file.mime_type, filename=message_file.original_filename)


@router.post("/{message_id}/forward", response_model=ForwardMessageResponse, status_code=status.HTTP_201_CREATED)
def forward_message(
    message_id: int,
    payload: ForwardMessageCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    source_message = _get_message_or_404(db, message_id)

    if not is_conversation_member(db, source_message.conversation_id, current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have access to this conversation")

    # De-duplicate while preserving order, in case the client sends the same
    # target conversation twice.
    seen = set()
    conversation_ids = [c for c in payload.conversation_ids if not (c in seen or seen.add(c))]

    # Validate access to every target BEFORE creating anything, so a forward
    # to N conversations never partially succeeds when the caller lacks
    # access to just one of them.
    for conversation_id in conversation_ids:
        if not is_conversation_member(db, conversation_id, current_user.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to one of the selected conversations",
            )

    now = datetime.now(timezone.utc)
    new_messages = []
    for conversation_id in conversation_ids:
        # A fresh message with its own sender (the forwarder, not the
        # original author) and a snapshot of the original content — the
        # original row itself is never touched. forwarded_from_message_id
        # is what lets the UI still show the original sender/content.
        message = Message(
            conversation_id=conversation_id,
            sender_id=current_user.id,
            content=source_message.content,
            forwarded_from_message_id=source_message.id,
        )
        db.add(message)
        new_messages.append(message)

        conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
        conversation.updated_at = now

    db.commit()

    forward_preview = ForwardPreview(
        id=source_message.id,
        sender_id=source_message.sender_id,
        sender_name=source_message.sender.name,
        content=source_message.content,
    )

    message_outs = []
    for message in new_messages:
        db.refresh(message)
        message_out = MessageOut.model_validate(message)
        message_out.forwarded_from = forward_preview
        message_outs.append(message_out)

    return ForwardMessageResponse(success=True, messages=message_outs)


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
