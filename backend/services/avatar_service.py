"""
Avatar upload business logic: real-image validation (via Pillow, never the
client's claimed Content-Type or filename extension), square-crop/resize/
re-encode, on-disk storage under a directory dedicated to avatars (never
mixed with shared chat files — see config.AVATAR_DIR), and safe replacement
of a user's previous avatar. Kept out of routers/users.py so the route
handler stays thin — same split as file_service.py.
"""
import io
import os
import uuid
from typing import Optional

from fastapi import UploadFile
from PIL import Image, ImageOps
from sqlalchemy.orm import Session

from config import AVATAR_DIR, AVATAR_MAX_DIMENSION, MAX_AVATAR_SIZE_BYTES
from models import User

_CHUNK_SIZE = 1024 * 1024  # 1 MiB per read — bounds peak memory regardless of upload size
_ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
_OUTPUT_EXTENSION = ".jpg"


class AvatarRejected(Exception):
    """Validation failed (not an image, unsupported format, empty file) —
    routers/users.py maps this to a 422."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class AvatarTooLarge(Exception):
    """Bytes actually read exceeded MAX_AVATAR_SIZE_BYTES — routers/users.py
    maps this to a 413."""


async def _read_with_limit(file: UploadFile) -> bytes:
    """
    Stream-read the whole upload into memory, aborting the instant the real
    byte count (never file.size or Content-Length — either can be absent or
    lie) crosses MAX_AVATAR_SIZE_BYTES. Buffered rather than streamed to
    disk like file_service._stream_to_disk: avatars are capped small enough
    for that to be safe, and Pillow needs the complete bytes in hand anyway
    to decode and validate.
    """
    chunks = []
    size = 0
    while True:
        chunk = await file.read(_CHUNK_SIZE)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_AVATAR_SIZE_BYTES:
            raise AvatarTooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


def _decode_and_normalize(raw: bytes) -> Image.Image:
    """
    Decodes `raw` as an image and returns a fresh RGB pixel buffer — the
    ONLY thing trusted here is what Pillow itself can successfully decode,
    regardless of what filename or Content-Type the client claimed. Once
    this returns, `raw`'s original bytes are never touched again: the
    re-encode in save_avatar() means whatever non-pixel data the upload
    carried (embedded scripts, EXIF/XMP/ICC blobs, polyglot payloads) never
    survives into the stored file. Pillow's own decompression-bomb guard
    (Image.MAX_IMAGE_PIXELS) rejects absurdly large pixel counts as a side
    effect of the `.load()` call below.
    """
    try:
        probe = Image.open(io.BytesIO(raw))
        probe.verify()  # cheap structural check; invalidates `probe` for further use
    except Exception:
        raise AvatarRejected("The uploaded file is not a valid image")

    if probe.format not in _ALLOWED_FORMATS:
        raise AvatarRejected("Only JPG, PNG, and WebP images are supported")

    try:
        image = Image.open(io.BytesIO(raw))
        image.load()  # forces full decode now, while we still control the exception
    except Exception:
        raise AvatarRejected("The uploaded file is not a valid image")

    image = ImageOps.exif_transpose(image)  # respect camera/phone orientation before cropping

    if image.mode in ("RGBA", "LA", "P"):
        # Flatten transparency onto white rather than letting a bare
        # .convert("RGB") turn it black — the square avatar shows up on
        # varied surfaces (light theme, dark theme, colored bubbles), so
        # white is the least-surprising neutral background.
        rgba = image.convert("RGBA")
        background = Image.new("RGB", image.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[3])
        image = background
    else:
        image = image.convert("RGB")

    return image


def _square_crop_and_resize(image: Image.Image) -> Image.Image:
    """Center-crop to a square, then resize to the configured max
    dimension — a consistent square avatar regardless of the source aspect
    ratio, per the task's requirement. LANCZOS preserves quality even when
    downscaling a much larger source image."""
    target = AVATAR_MAX_DIMENSION
    return ImageOps.fit(image, (target, target), method=Image.LANCZOS)


def _user_avatar_dir(user_id: int) -> str:
    """One subdirectory per user — makes "never overwrite another user's
    avatar" true by construction (user_id here is always the JWT-
    authenticated caller's own id, never client input) rather than
    something save_avatar has to reason about."""
    path = os.path.join(AVATAR_DIR, str(user_id))
    os.makedirs(path, exist_ok=True)
    return path


def resolve_absolute_path(relative_path: str) -> Optional[str]:
    """Join a stored relative_path back onto AVATAR_DIR and confirm the
    result is still inside it — same guarantee as
    file_service.resolve_absolute_path, just scoped to the dedicated
    avatar directory."""
    base = os.path.realpath(AVATAR_DIR)
    candidate = os.path.realpath(os.path.join(AVATAR_DIR, relative_path))
    if os.path.commonpath([base, candidate]) != base:
        return None
    return candidate


def _remove_if_exists(path: str) -> None:
    if os.path.exists(path):
        os.remove(path)


async def save_avatar(db: Session, user: User, file: UploadFile) -> None:
    """
    Validate, normalize, square-crop, and save `file` as `user`'s new
    avatar, then update user.avatar_path and remove the previous avatar
    file (if any). Raises AvatarRejected or AvatarTooLarge — both are
    raised before anything is written to disk, so a rejected upload never
    touches the user's existing avatar.
    """
    raw = await _read_with_limit(file)
    if not raw:
        raise AvatarRejected("The selected file is empty")

    image = _decode_and_normalize(raw)
    image = _square_crop_and_resize(image)

    # Server-generated name only — never derived from the client's filename
    # (see file_service._sanitize_original_filename's docstring for why
    # that matters for path traversal) — and always .jpg, since every
    # avatar is re-encoded to JPEG above regardless of its original format.
    absolute_dir = _user_avatar_dir(user.id)
    stored_filename = f"{uuid.uuid4().hex}{_OUTPUT_EXTENSION}"
    absolute_path = os.path.join(absolute_dir, stored_filename)

    image.save(absolute_path, format="JPEG", quality=90)

    relative_path = os.path.join(str(user.id), stored_filename)
    previous_relative_path = user.avatar_path
    user.avatar_path = relative_path

    try:
        db.commit()
    except Exception:
        db.rollback()
        _remove_if_exists(absolute_path)
        raise
    db.refresh(user)

    # Only safe to delete the old file AFTER the new path is durably
    # committed — avatars are 1:1 with a user (never shared/referenced
    # elsewhere), so once the DB row points at the new file the old one is
    # unconditionally orphaned.
    if previous_relative_path:
        previous_absolute = resolve_absolute_path(previous_relative_path)
        if previous_absolute:
            _remove_if_exists(previous_absolute)
