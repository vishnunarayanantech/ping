"""User search — powers the sidebar search in the main chat app."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import UserOut, UserSearchResponse
from security import get_current_user

router = APIRouter(prefix="/users", tags=["users"])


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
