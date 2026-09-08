# PING

Internal company communication platform — a lightweight alternative to Microsoft Teams.

Current foundation: registration, login, user search, one-to-one direct messaging, and a
recent-conversations sidebar, all end to end and backed by a real `conversations` /
`conversation_members` schema (not just `sender_id`/`receiver_id` pairs — see "Data model"
below). No WebSockets yet — the open conversation polls the REST API every 5s. Group chats,
channels, unread counts, and real-time transport come in later iterations.

## Architecture

```text
HTML + CSS + jQuery   (frontend/)
        │  AJAX / JSON, Authorization: Bearer <JWT>
        ▼
REST API               (backend/main.py + backend/routers/*.py)
        │
        ▼
FastAPI + SQLAlchemy    (backend/)
        │
        ▼
SQLite (dev) → PostgreSQL (production, via DATABASE_URL)
```

The frontend never touches the database directly — every request goes through the
`/api/v1` REST API, and every protected endpoint independently verifies the caller's
JWT server-side (see `backend/security.py`). The frontend's own "am I logged in?"
check (`Ping.isAuthenticated()`) is just a UI convenience to avoid flashing protected
pages before redirecting — it is not what actually protects anything.

## Project structure

```text
PING/
├── backend/
│   ├── main.py              FastAPI app, CORS, error handlers, router wiring
│   ├── database.py          SQLAlchemy engine/session (SQLite by default)
│   ├── models.py            User, Conversation, ConversationMember, Message tables
│   ├── schemas.py           Pydantic request/response models
│   ├── security.py          Password hashing + JWT create/verify + get_current_user
│   ├── services/
│   │   └── conversation_service.py  get-or-create direct conversation, sidebar query
│   ├── requirements.txt
│   ├── .env.example
│   └── routers/
│       ├── auth.py          POST /api/v1/auth/register, /login
│       ├── users.py         GET  /api/v1/users/search?q=
│       ├── conversations.py GET /api/v1/conversations, POST /api/v1/conversations/direct/{user_id}
│       └── messages.py      POST /api/v1/messages, GET /api/v1/messages/conversation/{id}
│
├── frontend/
│   ├── index.html           Routes to dashboard or login based on session
│   ├── auth/
│   │   ├── login.html
│   │   ├── register.html
│   │   ├── forgot-password.html   (frontend-only demo — no backend endpoint yet)
│   │   └── reset-password.html    (frontend-only demo — no backend endpoint yet)
│   ├── dashboard/
│   │   └── index.html       Main app: sidebar search + one-to-one chat
│   ├── profile/
│   │   └── profile.html     Built in an earlier iteration, not yet wired to the API
│   └── assets/
│       ├── css/main.css
│       ├── js/
│       │   ├── config.js    APP_CONFIG + API_BASE_URL — edit this to rebrand or repoint the API
│       │   ├── main.js      Shared "Ping" utilities: toasts, theme, session/token, initials, etc.
│       │   ├── api.js       Reusable AJAX helper — attaches the JWT, handles 401 by logging out
│       │   ├── auth.js      Login + register form logic
│       │   ├── users.js     Debounced user search (owns the results dropdown)
│       │   ├── conversations.js  Recent-chats sidebar: load, render, active state, get-or-create
│       │   ├── chat.js      Open conversation: message rendering, send, polling
│       │   └── dashboard.js Wires auth guard + Conversations + Users + Chat together
│       └── images/logo.svg
│
├── .gitignore
└── README.md
```

## Installation

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

The API runs at `http://127.0.0.1:8000`. Interactive docs at `http://127.0.0.1:8000/docs`.

On first run it creates `backend/ping.db` (SQLite) automatically — no migration step needed.
`Base.metadata.create_all()` only creates tables that don't exist yet; it never drops or
alters existing ones, so pulling new code that adds a model (like `Message`) and restarting
the server is always safe against a database that already has real rows in it.

To point at PostgreSQL later, copy `.env.example` to `.env`, set `DATABASE_URL`, and
`pip install psycopg2-binary`. No code changes required.

### 2. Frontend

The frontend is static files, but **must be served over HTTP, not opened via `file://`** —
the browser sends `Origin: null` for `file://` pages, which the backend's CORS policy
(intentionally) does not allow. Any static server works, e.g.:

```bash
cd frontend
python3 -m http.server 5500
```

Then open `http://127.0.0.1:5500` in a browser. If you serve it from a different port,
add that origin to `DEV_ORIGINS` in `backend/main.py`.

## Authentication

Login returns a JWT (`access_token`, HS256, 24h expiry — no refresh tokens yet). The
frontend stores it in `localStorage` alongside the user's display info and attaches it
as `Authorization: Bearer <token>` on every subsequent API call via `api.js`. Every
protected endpoint (`/users/search`, `/conversations*`, `/messages*`) resolves the caller
through `security.get_current_user` — the sender of a message is always taken from the
verified token, never from the request body, and conversation endpoints additionally check
the caller is actually a member (see "Data model" above) before returning anything.

`SECRET_KEY` (in `.env`, see `.env.example`) signs these tokens. The code falls back to
an insecure hardcoded dev value if unset — fine for solo local use, never for anything
shared. Generate a real one with:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

## API

Base path: `/api/v1`

| Method | Path                                   | Auth | Body                              |
|--------|-----------------------------------------|------|-------------------------------------|
| POST   | `/auth/register`                        | —    | `{ name, email, password }`         |
| POST   | `/auth/login`                           | —    | `{ email, password }`               |
| GET    | `/users/search?q=`                      | JWT  | —                                    |
| GET    | `/conversations`                        | JWT  | —                                    |
| POST   | `/conversations/direct/{user_id}`       | JWT  | — (get-or-create, never duplicates)  |
| POST   | `/messages`                             | JWT  | `{ conversation_id, content }`      |
| GET    | `/messages/conversation/{conversation_id}` | JWT | —                                 |

Every response uses the same envelope shape: `{ "success": bool, "message"|"messages"|"users"|"conversations"|"conversation": ... }`.
Errors are always `{ "success": false, "message": "..." }` with an appropriate status code
(401 unauthenticated/invalid credentials, 403 not a conversation member, 404 not found,
409 duplicate email, 422 validation, 500 unhandled). Password hashes are never included in
any response.

## Data model

`users`, `conversations`, `conversation_members`, `messages` — see `backend/models.py`.
A message belongs to a conversation (`conversation_id`) and a sender; a conversation's
members live in `conversation_members`, not on the message itself. This replaced an earlier
`sender_id`/`receiver_id`-on-message design — see "Schema history" below.

- **Get-or-create, never duplicate**: `services.conversation_service.get_or_create_direct_conversation`
  is the *only* place a conversation or membership row is created. It looks for an existing
  `type="direct"` conversation containing both users before creating a new one, so searching
  for and opening the same person twice always resolves to the same conversation.
- **Membership is the access-control boundary**: both `POST /messages` and
  `GET /messages/conversation/{id}` call `is_conversation_member()` before doing anything else
  and return `403` (deliberately the same error whether the conversation doesn't exist or the
  caller just isn't in it) if the check fails. A conversation ID alone never grants access.
- **Sidebar query is O(1) round trips, not O(n)**: `get_user_conversations()` fetches the
  user's conversations, their latest message, and the other member in a small fixed number of
  queries (a grouped `MAX(id)` subquery for "latest message per conversation," not "load every
  message and sort in Python"). `id` (not `created_at`) breaks ties for the same coarse-SQLite-
  timestamp reason noted below.
- **Ordering**: conversations sort by `updated_at DESC` at the SQL level; `updated_at` is bumped
  explicitly whenever a message is sent (`routers/messages.py`), which is what moves a
  conversation back to the top of the sidebar.
- Message ordering within a conversation is `(created_at, id)`, not just `created_at` — SQLite's
  timestamp resolution is coarse enough that two rapid messages can share a value, and `id` is
  the only thing that then reliably breaks the tie the same way for every reader.

### Schema history

The `messages` table originally had `sender_id`/`receiver_id` and no `conversations` table at
all — a conversation was just "wherever this pair of IDs appears." That doesn't extend to group
chats, so it was replaced with `conversation_id` + a proper `conversations`/`conversation_members`
schema. `Base.metadata.create_all()` cannot alter an existing table's columns (only create whole
new tables), so this was a breaking change for anyone with a database from before it — the fix
during development was simply to delete `backend/ping.db` and let the server recreate it with
the new schema on next startup. There was no real user data at stake at that point, which is
what made a clean reset (rather than a data-preserving migration script) the right call — do the
same if you're upgrading a database that predates this section and don't need to keep its rows.
A production database with real rows to preserve would need an actual migration (e.g. Alembic)
instead; none exists in this project yet.

## Real-time strategy

No WebSockets yet, by design. While a conversation is open, `chat.js` re-fetches and fully
*replaces* the message list every 5 seconds (`Chat.startPolling()` / `stopPolling()`) —
replacing rather than appending is what makes a just-sent message immune to ever appearing
twice once the next poll confirms it from the server. Polling always stops when a
conversation closes or on logout, and is never started twice. `startPolling()`/`stopPolling()`
are the intended seam for a future WebSocket connection to plug into.

## Sidebar edge case: conversations with no messages

Opening a chat (clicking a search result) calls the get-or-create endpoint immediately, before
any message is sent — that's what guarantees searching for and clicking the same person twice
never creates a duplicate conversation. One consequence: if you open a conversation and send
nothing, that empty conversation *is* a real row and *will* show up in your sidebar on next
load, with "No messages yet" as its preview instead of a last-message snippet. This is handled
deliberately (`conversations.js` renders that placeholder text rather than breaking), not
filtered out — narrowing it to "only show after the first message" would need a backend change
to `get_user_conversations()` if that's ever preferred instead.

## CORS

Configured in `backend/main.py` (`DEV_ORIGINS`). Update that list — or replace it with
the real deployed frontend origin — before shipping to production. Never set
`allow_origins=["*"]` while `allow_credentials=True`.

## Security notes (prototype-stage)

- Passwords are hashed with bcrypt (via passlib) — never stored or returned in plain text.
- Every protected endpoint requires and independently verifies a JWT — the frontend's
  localStorage check is a UI convenience only, never the actual security boundary.
- `backend/.env.example` documents `DATABASE_URL` and `SECRET_KEY`. `.env` itself is gitignored.
- The SQLite database file (`backend/ping.db`) is also gitignored — never commit it.
- Frontend validation (required fields, email format, length, match) is a UX convenience
  only; the backend independently re-validates everything via Pydantic and its own checks.
- Message content is always inserted via jQuery `.text()`, never `.html()` — untrusted
  user input is never treated as markup.
