"""
File-upload business logic: filename sanitization, on-disk storage layout,
size-limited streaming save, and the Message/MessageFile rows it creates.
Kept out of routers/messages.py so the route handler stays thin — same
split as reaction_service.py / reply_service.py / forward_service.py.

Every file upload creates its OWN Message — there's no "attach a file to an
existing text message" path (see MessageFile's docstring in models.py).
"""
import mimetypes
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from fastapi import UploadFile
from sqlalchemy.orm import Session

from config import BLOCKED_UPLOAD_EXTENSIONS, MAX_UPLOAD_SIZE_BYTES, UPLOAD_DIR
from models import Conversation, Message, MessageFile
from schemas import MessageFileOut

_CHUNK_SIZE = 1024 * 1024  # 1 MiB per read — bounds peak memory regardless of file size
_EXTENSION_RE = re.compile(r"^\.[a-z0-9]{1,10}$")


class UploadRejected(Exception):
    """Filename/extension/empty-file validation failed — routers/messages.py
    maps this to a 422."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class UploadTooLarge(Exception):
    """Bytes actually read exceeded MAX_UPLOAD_SIZE_BYTES — routers/messages.py
    maps this to a 413."""


def _sanitize_original_filename(filename: str) -> str:
    """
    Reduce a client-supplied filename to something safe to store as DISPLAY
    text and hand back in a Content-Disposition header — never used to
    build an on-disk path (see _build_storage_path, which is entirely
    server-generated). Strips any directory component (defeats
    "../../etc/passwd"-style traversal), null bytes, and other control
    characters; falls back to a generic name if nothing usable survives.
    """
    name = (filename or "").replace("\\", "/")
    name = os.path.basename(name)
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    name = name.lstrip(".")  # blocks bare ".."/"." and hidden-file-looking names
    if not name:
        name = "file"
    return name[:255]


def _safe_extension(filename: str) -> str:
    """The lowercased extension if it's short and alphanumeric, else "" (the
    stored file just gets no extension) — keeps a crafted filename from
    injecting path separators or oversized garbage into the stored name."""
    _, ext = os.path.splitext(filename)
    ext = ext.lower()
    return ext if _EXTENSION_RE.match(ext) else ""


def _guess_mime_type(filename: str) -> str:
    """Derived from the (sanitized) filename's extension — the client's
    reported Content-Type is never trusted for anything security-relevant,
    per the task's requirement; this is only for the browser's benefit on
    download (correct icon/handler), never an access-control decision."""
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def _build_storage_path(conversation_id: int, extension: str) -> Tuple[str, str]:
    """
    Returns (relative_path, absolute_path) for a brand-new, guaranteed-
    unique stored file — a UUID4 name, so two users uploading files named
    identically can never collide or overwrite each other (no "_1", "_2"
    suffix scheme needed; see the task's duplicate-filename requirement).
    Organized by conversation then year/month so one directory never ends
    up holding every file the app has ever received.
    """
    now = datetime.now(timezone.utc)
    relative_dir = os.path.join("conversations", str(conversation_id), f"{now.year:04d}", f"{now.month:02d}")
    absolute_dir = os.path.join(UPLOAD_DIR, relative_dir)
    os.makedirs(absolute_dir, exist_ok=True)

    stored_filename = f"{uuid.uuid4().hex}{extension}"
    return os.path.join(relative_dir, stored_filename), os.path.join(absolute_dir, stored_filename)


def _remove_if_exists(path: str) -> None:
    if os.path.exists(path):
        os.remove(path)


async def _stream_to_disk(file: UploadFile, absolute_path: str) -> int:
    """
    Write `file` to `absolute_path` in fixed-size chunks, counting actual
    bytes read rather than trusting file.size or the request's
    Content-Length header (either can be absent or lie) — aborts and
    deletes the partial file the instant the real byte count crosses the
    configured limit, so a misbehaving client can never make this write
    more than MAX_UPLOAD_SIZE_BYTES (+ one chunk) to disk.
    """
    size = 0
    try:
        with open(absolute_path, "wb") as out:
            while True:
                chunk = await file.read(_CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_SIZE_BYTES:
                    raise UploadTooLarge()
                out.write(chunk)
    except Exception:
        _remove_if_exists(absolute_path)
        raise
    return size


def resolve_absolute_path(relative_path: str) -> Optional[str]:
    """Join a stored relative_path back onto UPLOAD_DIR and confirm the
    result is still inside it. file_path is always server-generated (see
    _build_storage_path), so this never actually catches anything in
    practice — it's a one-line guarantee against ever serving a path
    outside the upload directory if that assumption is ever violated."""
    base = os.path.realpath(UPLOAD_DIR)
    candidate = os.path.realpath(os.path.join(UPLOAD_DIR, relative_path))
    if os.path.commonpath([base, candidate]) != base:
        return None
    return candidate


async def save_message_file(db: Session, conversation_id: int, sender_id: int, file: UploadFile) -> Message:
    """
    Validate, stream-save, and record one uploaded file as a brand-new
    message in `conversation_id`. Raises UploadRejected or UploadTooLarge —
    routers/messages.py translates both to HTTP responses. Caller must
    already have verified conversation membership.
    """
    original_filename = _sanitize_original_filename(file.filename or "")
    extension = _safe_extension(original_filename)
    if extension in BLOCKED_UPLOAD_EXTENSIONS:
        raise UploadRejected(f"Files of type {extension} are not allowed")

    relative_path, absolute_path = _build_storage_path(conversation_id, extension)
    size = await _stream_to_disk(file, absolute_path)
    if size == 0:
        _remove_if_exists(absolute_path)
        raise UploadRejected("The selected file is empty")

    mime_type = _guess_mime_type(original_filename)

    # Prefixed so the sidebar's last-message preview (conversations.js, which
    # just renders `content` as-is) reads as "shared a file" instead of a
    # bare filename with no context.
    message = Message(conversation_id=conversation_id, sender_id=sender_id, content=f"\U0001F4CE {original_filename}")
    db.add(message)
    db.flush()  # assigns message.id without committing yet

    db.add(
        MessageFile(
            message_id=message.id,
            original_filename=original_filename,
            stored_filename=os.path.basename(relative_path),
            file_path=relative_path,
            mime_type=mime_type,
            file_size=size,
        )
    )

    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    conversation.updated_at = datetime.now(timezone.utc)

    try:
        db.commit()
    except Exception:
        db.rollback()
        _remove_if_exists(absolute_path)
        raise
    db.refresh(message)
    return message


def get_file_for_message(db: Session, message_id: int) -> Optional[MessageFile]:
    return db.query(MessageFile).filter(MessageFile.message_id == message_id).first()


def get_files_by_message(db: Session, message_ids: List[int]) -> Dict[int, MessageFileOut]:
    """Batch version for GET /messages/conversation/{id} — one query
    regardless of how many messages are passed in, same pattern as
    reaction_service.get_reactions_by_message."""
    if not message_ids:
        return {}
    rows = db.query(MessageFile).filter(MessageFile.message_id.in_(message_ids)).all()
    return {row.message_id: MessageFileOut.model_validate(row) for row in rows}
