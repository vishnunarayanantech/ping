"""
PING backend entrypoint. Run from inside backend/ with:

    uvicorn main:app --reload

Wires together the database, routers, CORS, and consistent {success,
message} error responses (so the frontend never has to special-case
FastAPI's default error shapes).
"""
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from database import Base, engine
from routers import auth, conversations, messages, users

# Every router is imported above (and each imports its models, directly or
# transitively) BEFORE create_all() runs, so every table — including new
# ones like Conversation/ConversationMember — gets registered on
# Base.metadata. create_all() only creates tables that don't exist yet; it
# never drops or alters existing ones (including columns on a table that
# already exists) — see README's "Schema changes" note for what that means
# when a model's columns change, as Message's just did.
Base.metadata.create_all(bind=engine)

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


@app.get("/")
def root():
    return {"service": "PING API", "status": "ok"}
