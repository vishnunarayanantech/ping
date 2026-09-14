"""
PING backend entrypoint. Run from inside backend/ with:

    uvicorn main:app --reload

Wires together the database, routers, CORS, and consistent {success,
message} error responses (so the frontend never has to special-case
FastAPI's default error shapes).
"""
from sqlalchemy import inspect, text

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from database import Base, engine
from routers import auth, calls, conversations, messages, users

# Every router is imported above (and each imports its models, directly or
# transitively) BEFORE create_all() runs, so every table — including new
# ones like Conversation/ConversationMember — gets registered on
# Base.metadata. create_all() only creates tables that don't exist yet; it
# never drops or alters existing ones (including columns on a table that
# already exists) — see README's "Schema changes" note for what that means
# when a model's columns change, as Message's just did.
Base.metadata.create_all(bind=engine)


def _add_missing_columns():
    """
    create_all() can't add a column to a table that already exists (see
    above), which is exactly what happened when unread-tracking added
    `conversation_members.last_read_at` to a table that predates it. Rather
    than delete ping.db (fine when there was no real data at stake, per
    README "Schema history" — not true here), do the one-column ALTER TABLE
    by hand. Idempotent: a no-op once the column exists, so it's always safe
    to run on startup, on any database whether it's old or brand new.
    """
    inspector = inspect(engine)

    conversation_member_columns = {col["name"] for col in inspector.get_columns("conversation_members")}
    if "last_read_at" not in conversation_member_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE conversation_members ADD COLUMN last_read_at TIMESTAMP"))

    # reply-to-message: same trick for `messages.reply_to_message_id`, added
    # after this table already held real rows. Every existing message ends
    # up with NULL here, which is exactly "not a reply" — no backfill needed.
    message_columns = {col["name"] for col in inspector.get_columns("messages")}
    if "reply_to_message_id" not in message_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER REFERENCES messages(id)"))

    # forward-message: same trick again for `messages.forwarded_from_message_id`.
    # Every existing message ends up with NULL here, which is exactly "not a
    # forward" — no backfill needed.
    message_columns = {col["name"] for col in inspector.get_columns("messages")}
    if "forwarded_from_message_id" not in message_columns:
        with engine.begin() as conn:
            conn.execute(
                text("ALTER TABLE messages ADD COLUMN forwarded_from_message_id INTEGER REFERENCES messages(id)")
            )

    # message editing: same trick for `messages.edited_at`. Every existing
    # message ends up with NULL here, which is exactly "never edited" — no
    # backfill needed, and old messages render exactly as before.
    message_columns = {col["name"] for col in inspector.get_columns("messages")}
    if "edited_at" not in message_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE messages ADD COLUMN edited_at TIMESTAMP"))

    # editable profile fields: same trick for users.job_title/department
    # (both start '' for existing rows — "no title set yet", not NULL, so
    # the frontend never has to special-case a null string) and
    # users.employee_id (backfilled deterministically from each row's id so
    # every existing user gets a stable, unique value with no manual data
    # entry). New users get all three set at registration time instead —
    # see routers/auth.py.
    user_columns = {col["name"] for col in inspector.get_columns("users")}
    if "job_title" not in user_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN job_title VARCHAR"))
            conn.execute(text("UPDATE users SET job_title = '' WHERE job_title IS NULL"))
    if "department" not in user_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN department VARCHAR"))
            conn.execute(text("UPDATE users SET department = '' WHERE department IS NULL"))
    if "employee_id" not in user_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN employee_id VARCHAR"))
            conn.execute(text("UPDATE users SET employee_id = 'EMP-' || (1000 + id) WHERE employee_id IS NULL"))
            conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_employee_id ON users (employee_id)"))

    # avatar upload: same trick for users.avatar_path. Every existing user
    # ends up with NULL here, which is exactly "no avatar uploaded yet" — the
    # frontend already falls back to the initials avatar for that case, so
    # no backfill needed.
    if "avatar_path" not in user_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN avatar_path VARCHAR"))

    # video calling: same trick for calls.call_type. Every existing call row
    # predates video calling, so it's backfilled to 'audio' — exactly what
    # every one of those calls actually was.
    call_columns = {col["name"] for col in inspector.get_columns("calls")}
    if "call_type" not in call_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE calls ADD COLUMN call_type VARCHAR"))
            conn.execute(text("UPDATE calls SET call_type = 'audio' WHERE call_type IS NULL"))

    # group calling: same trick for calls.scope. Every existing call row
    # predates group calling, so it's backfilled to 'direct' — exactly what
    # every one of those calls actually was (see models.Call's scope
    # docstring). call_participants itself needs no manual migration here —
    # it's a brand new table, so Base.metadata.create_all() above already
    # created it.
    call_columns = {col["name"] for col in inspector.get_columns("calls")}
    if "scope" not in call_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE calls ADD COLUMN scope VARCHAR"))
            conn.execute(text("UPDATE calls SET scope = 'direct' WHERE scope IS NULL"))

    # group calling: same trick for call_signaling.peer_user_id. Every
    # existing signal predates group calling and was necessarily a direct-
    # call signal, so NULL here (see models.CallSignal's peer_user_id
    # docstring) is exactly correct with no backfill needed.
    signal_columns = {col["name"] for col in inspector.get_columns("call_signaling")}
    if "peer_user_id" not in signal_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE call_signaling ADD COLUMN peer_user_id INTEGER REFERENCES users(id)"))


_add_missing_columns()

app = FastAPI(title="PING API", version="0.3.0")

# --- CORS -------------------------------------------------------------
# Origins the static jQuery frontend is served from during development
# (e.g. `python -m http.server`, VS Code Live Server, `npx serve`).
#
# PRODUCTION: replace this list with the frontend's real deployed origin(s).
# Never set allow_origins=["*"] while allow_credentials=True — browsers
# reject that combination, and it's a wide-open CORS hole regardless.
DEV_ORIGINS = [
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=DEV_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Flatten Pydantic's default {"detail": [...]} shape into {success, message}."""
    first_error = exc.errors()[0]
    field = first_error["loc"][-1]
    return JSONResponse(
        status_code=422,
        content={"success": False, "message": f"Invalid {field}: {first_error['msg']}"},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Flatten any raised HTTPException (auth, not-found, etc.) into {success, message}."""
    return JSONResponse(status_code=exc.status_code, content={"success": False, "message": str(exc.detail)})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Never leak internal errors/stack traces to the client."""
    return JSONResponse(
        status_code=500,
        content={"success": False, "message": "Something went wrong. Please try again."},
    )


app.include_router(auth.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")
app.include_router(conversations.router, prefix="/api/v1")
app.include_router(messages.router, prefix="/api/v1")
app.include_router(calls.router, prefix="/api/v1")


@app.get("/")
def root():
    return {"service": "PING API", "status": "ok"}
