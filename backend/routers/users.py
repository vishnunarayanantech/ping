"""User search, the logged-in user's own profile, and avatars."""
import os

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from config import MAX_AVATAR_SIZE_MB
from database import get_db
from models import User
from schemas import ProfileResponse, ProfileUpdate, UserOut, UserProfileOut, UserSearchResponse, build_avatar_url
from security import get_current_user
from services import avatar_service

router = APIRouter(prefix="/users", tags=["users"])


def _to_profile_out(user: User) -> UserProfileOut:
    return UserProfileOut(
        id=user.id,
        full_name=user.name,
        job_title=user.job_title or "",
        department=user.department or "",
        company_email=user.email,
        employee_id=user.employee_id or "",
        avatar_url=build_avatar_url(user.id, user.avatar_path),
    )


@router.get("/search", response_model=UserSearchResponse)
def search_users(
    q: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = q.strip()
    if len(query) < 2:
        return UserSearchResponse(success=True, users=[])

    results = (
        db.query(User)
        .filter(User.id != current_user.id)
        .filter(User.name.ilike(f"%{query}%"))
        .order_by(User.name)
        .limit(10)
        .all()
    )
    return UserSearchResponse(success=True, users=[UserOut.model_validate(u) for u in results])


@router.get("/profile", response_model=ProfileResponse)
def get_profile(current_user: User = Depends(get_current_user)):
    """The logged-in user's own full profile. current_user is resolved
    purely from the JWT (see security.get_current_user) — there's no path
    or query parameter here a caller could point at someone else's id."""
    return ProfileResponse(success=True, message="Profile retrieved successfully", profile=_to_profile_out(current_user))


@router.put("/profile", response_model=ProfileResponse)
def update_profile(
    payload: ProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Updates only full_name/job_title/department on the JWT-authenticated
    caller's own row. company_email, employee_id, and id are never touched
    here — ProfileUpdate has no fields for them, so there's nothing in the
    validated payload that could carry them even if a client tried."""
    current_user.name = payload.full_name
    current_user.job_title = payload.job_title
    current_user.department = payload.department
    db.commit()
    db.refresh(current_user)
    return ProfileResponse(success=True, message="Profile updated successfully", profile=_to_profile_out(current_user))


@router.post("/profile/avatar", response_model=ProfileResponse)
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Replaces the JWT-authenticated caller's own avatar — there's no user
    id in this request for a client to point at someone else's row (same
    "target is always current_user" shape as PUT /users/profile above).
    Validation, normalization, storage, and old-file cleanup all live in
    avatar_service.save_avatar; this just translates its exceptions to HTTP
    responses."""
    try:
        await avatar_service.save_avatar(db, current_user, file)
    except avatar_service.AvatarRejected as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.message)
    except avatar_service.AvatarTooLarge:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Avatar exceeds the {MAX_AVATAR_SIZE_MB:.0f} MB limit",
        )
    return ProfileResponse(success=True, message="Avatar updated successfully", profile=_to_profile_out(current_user))


@router.get("/{user_id}/avatar")
def get_avatar(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Serves a user's avatar image. Requires a valid session (get_current_user)
    but isn't scoped to current_user's id or conversation membership — any
    logged-in coworker can already discover any other user's name/email via
    GET /users/search, and an avatar carries no more sensitivity than that,
    unlike a shared chat file (see routers/messages.py's conversation-
    membership check on file download, which exists because THAT content is
    private to the conversation)."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user or not user.avatar_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    absolute_path = avatar_service.resolve_absolute_path(user.avatar_path)
    if not absolute_path or not os.path.isfile(absolute_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    return FileResponse(absolute_path, media_type="image/jpeg")
