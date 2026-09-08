"""
Password hashing and JWT helpers — kept separate from the route handlers
(routers/auth.py, routers/users.py, routers/messages.py) that use them.
"""
import os
from datetime import datetime, timedelta, timezone

import jwt
from dotenv import load_dotenv
from fastapi import Depends, Header, HTTPException, status
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from database import get_db
from models import User

load_dotenv()

# --- Password hashing -------------------------------------------------
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


# --- JWT ----------------------------------------------------------------
# SECRET_KEY must be overridden via .env in any shared environment — the
# fallback below is only fine for a solo local prototype. See .env.example.
SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-insecure-secret-change-me")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24h — no refresh tokens yet, so this is a deliberately
# generous prototype-stage tradeoff between security and not annoying testers with re-logins.


def create_access_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": str(user_id), "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(authorization: str = Header(default=None), db: Session = Depends(get_db)) -> User:
    """FastAPI dependency: resolves the request's Bearer token into a User, or raises 401."""
    invalid_session = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired session. Please log in again.",
    )

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")

    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise invalid_session

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise invalid_session

    return user
