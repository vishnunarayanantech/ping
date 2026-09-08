"""
SQLAlchemy engine/session setup.

DATABASE_URL defaults to a local SQLite file for development. To move to
PostgreSQL in production, set DATABASE_URL (e.g. in .env) to something like
"postgresql://user:password@host:5432/ping" and install psycopg2-binary —
no other code in this file needs to change.
"""
import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./ping.db")

# check_same_thread is only needed for SQLite, which otherwise forbids
# using a connection across the threads FastAPI's threadpool spins up.
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI dependency that yields a request-scoped DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
