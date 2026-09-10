# PING

Internal company communication platform — a lightweight alternative to Microsoft Teams.

Current foundation: registration, login, user search, one-to-one direct messaging, emoji
message reactions, replying to a specific message, forwarding, file sharing with inline media
previews, message editing, and one-to-one **audio calling** over WebRTC (see "Audio calling"
below), all end to end and backed by a real
`conversations` / `conversation_members` schema (not just `sender_id`/`receiver_id` pairs —
see "Data model" below). No WebSockets yet — the open conversation, sidebar, and an active
call all poll the REST API. Group chats, channels, video calling, and real-time transport
come in later iterations.

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
│   ├── config.py            Upload dir / max size / blocked extensions (env-configurable)
│   ├── models.py            User, Conversation, ConversationMember, Message, MessageReaction,
│   │                         MessageFile, Call, CallSignal tables
│   ├── schemas.py           Pydantic request/response models
│   ├── security.py          Password hashing + JWT create/verify + get_current_user
│   ├── uploads/              Uploaded files (gitignored) — see config.py's UPLOAD_DIR
│   ├── services/
│   │   ├── conversation_service.py  get-or-create direct conversation, sidebar query
│   │   ├── reaction_service.py      add/remove a reaction, aggregate reactions per message
│   │   ├── reply_service.py         validate a reply's target, batch-fetch quoted-preview info
│   │   ├── file_service.py          validate/stream-save an upload, build its message + row
│   │   └── call_service.py         create/accept/reject/cancel/hang-up a call, busy + lazy
│   │                                ring-timeout enforcement, signaling-message storage
│   ├── requirements.txt
│   ├── .env.example
│   └── routers/
│       ├── auth.py          POST /api/v1/auth/register, /login
│       ├── users.py         GET  /api/v1/users/search?q=
│       ├── conversations.py GET /api/v1/conversations, POST /api/v1/conversations/direct/{user_id}
│       ├── messages.py      POST /api/v1/messages, GET /api/v1/messages/conversation/{id},
│       │                     POST/DELETE /api/v1/messages/{id}/reactions[/{emoji}],
│       │                     POST /api/v1/messages/upload, GET /api/v1/messages/files/{id}/download
│       └── calls.py         POST /api/v1/calls, GET /api/v1/calls/active, GET /api/v1/calls/{id},
│                             POST /api/v1/calls/{id}/{accept,reject,cancel,hangup,signals},
│                             GET /api/v1/calls/ice-servers — see "Audio calling" below
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
│       │   ├── chat.js      Open conversation: message rendering, send, polling, reply-to-message UI
│       │   ├── upload.js    Composer's attach-file button: picker, progress bar, POST /messages/upload
│       │   ├── media.js     Blob-URL cache + fetch for inline image/video/audio previews, image lightbox
│       │   ├── calls.js     Call state machine + WebRTC (RTCPeerConnection) + the call overlay/bar —
│       │   │                 see "Audio calling" below
│       │   └── dashboard.js Wires auth guard + Conversations + Users + Chat + Upload + Media + Calls together
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
| GET    | `/conversations`                        | JWT  | — (each conversation includes `unread_count`) |
| POST   | `/conversations/direct/{user_id}`       | JWT  | — (get-or-create, never duplicates)  |
| POST   | `/conversations/{conversation_id}/read` | JWT  | — (sets caller's `last_read_at` for that conversation) |
| POST   | `/messages`                             | JWT  | `{ conversation_id, content, reply_to_message_id? }` |
| GET    | `/messages/conversation/{conversation_id}` | JWT | — (each message includes its `reactions` and, if a reply, its `reply_to` quoted preview) |
| POST   | `/messages/{message_id}/reactions`      | JWT  | `{ emoji }` (one of the 8 allowed — see below) |
| DELETE | `/messages/{message_id}/reactions/{emoji}` | JWT | —                                 |
| POST   | `/messages/upload`                      | JWT  | multipart form: `conversation_id`, `file` (creates a file-share message) |
| GET    | `/messages/files/{file_id}/download`    | JWT  | — (streams the file; caller must belong to its message's conversation) |
| GET    | `/calls/ice-servers`                    | JWT  | — (STUN/TURN config for `RTCPeerConnection` — see "Audio calling") |
| GET    | `/calls/active`                         | JWT  | — (the caller's current ringing/accepted call, or `null`) |
| POST   | `/calls`                                | JWT  | `{ conversation_id }` (receiver is derived from the OTHER member — never client-supplied; returns a `"busy"` call instead of erroring if either side is already on one) |
| GET    | `/calls/{call_id}?after_signal_id=`     | JWT  | — (current call state + every signaling message from the OTHER participant since `after_signal_id`, in one response) |
| POST   | `/calls/{call_id}/signals`              | JWT  | `{ message_type, payload }` (`message_type` one of `offer`/`answer`/`ice-candidate`; `payload` relayed opaque, never parsed) |
| POST   | `/calls/{call_id}/accept`               | JWT  | — (receiver only) |
| POST   | `/calls/{call_id}/reject`               | JWT  | — (receiver only) |
| POST   | `/calls/{call_id}/cancel`               | JWT  | — (caller only, before it's answered) |
| POST   | `/calls/{call_id}/hangup`               | JWT  | — (either participant, once accepted) |

Every response uses the same envelope shape: `{ "success": bool, "message"|"messages"|"users"|"conversations"|"conversation"|"reactions"|"call"|"signals"|"ice_servers": ... }`.
Errors are always `{ "success": false, "message": "..." }` with an appropriate status code
(401 unauthenticated/invalid credentials, 403 not a conversation member, 404 not found,
409 duplicate email, 422 validation, 500 unhandled). Password hashes are never included in
any response.

Both reaction endpoints return the message's full, freshly-aggregated `reactions` list (not
just the one emoji touched), so the frontend can replace its local copy outright instead of
patching it — each entry is `{ emoji, count, users: [{id, name}], reacted_by_me }`.

## Data model

`users`, `conversations`, `conversation_members`, `messages`, `message_reactions` — see
`backend/models.py`.
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
- **Unread tracking**: each `conversation_members` row has a `last_read_at` (NULL = "never read,
  everything is unread"). `get_unread_counts()` counts, per conversation, messages with
  `sender_id != user_id` and `created_at > last_read_at` — one grouped query across every
  conversation on the sidebar, not one query per conversation. `POST /conversations/{id}/read`
  (`mark_conversation_read()`) sets it to the conversation's latest message's `created_at` (or
  the current server time if there are no messages yet) rather than trusting the browser's clock.
- **Reactions**: `message_reactions` has a unique constraint on `(message_id, user_id, emoji)` —
  the DB itself is what guarantees a user can't double-react with the same emoji, not
  application-level checking (`reaction_service.add_reaction()` inserts and simply catches the
  resulting `IntegrityError` if the row already exists, which also makes it safe under a race
  between two near-simultaneous requests). Both `POST` and `DELETE` verify conversation
  membership first, the same as every other message endpoint. `get_reactions_by_message()`
  fetches and aggregates every message's reactions in one query regardless of how many messages
  are being listed — same batching principle as the sidebar query above — rather than one query
  per message.
- **Replies**: `messages.reply_to_message_id` is a nullable self-referential FK — NULL for an
  ordinary message. `POST /messages` validates it server-side via
  `reply_service.get_reply_target()`, which scopes the lookup to the *same* `conversation_id`
  the new message is being sent into, so a client can never make a message appear to quote one
  from a conversation it doesn't belong to; an invalid or cross-conversation target is rejected
  with `422`. No ORM relationship models this on purpose — same reasoning as `MessageReaction`'s
  docstring: the quoted-preview shape (`ReplyPreview`) needs the original sender's *name*, not
  the raw row, so `reply_service.get_reply_previews_by_message()` builds it explicitly, batched
  across every message in a `GET /messages/conversation/{id}` response in one query, the same
  batching principle as reactions above.
- **File sharing**: `message_files` is a 1:1 extension of `messages` (unique FK on
  `message_id`) — every upload creates its own message rather than attaching to an existing
  one, the same "no ORM relationship, build the shape explicitly" pattern as replies/forwards
  (`services/file_service.py`). Files live on disk under `backend/uploads/` (configurable via
  `UPLOAD_DIR`, see `backend/config.py`), organized `conversations/{id}/{year}/{month}/`, and
  are never served as static files — `GET /messages/files/{id}/download` is the only way to
  read one back, and it re-checks conversation membership the same as every other endpoint
  here. `stored_filename` is a UUID, so two users uploading identically-named files can never
  collide; `original_filename` is sanitized (path components and control characters stripped)
  before being stored purely for display and for the download's `Content-Disposition` header —
  it never influences where the file actually lands on disk. Uploads are streamed to disk in
  fixed-size chunks with the actual byte count checked against `MAX_UPLOAD_SIZE_MB` as they're
  written (never trusting `Content-Length` or the client alone), and rejected outright by
  extension (`BLOCKED_UPLOAD_EXTENSIONS`) regardless of the client's claimed MIME type — the
  stored MIME type is always guessed server-side from the sanitized filename instead.
- **Inline media previews**: `schemas.MessageFileOut.category` (`"image"` / `"video"` /
  `"audio"` / `"other"`) is a Pydantic `@computed_field` derived fresh from `mime_type` on every
  response, not a stored column — it can never drift out of sync with the field it's derived
  from. `image/svg+xml` is deliberately excluded from `"image"` (falls back to `"other"`) even
  though SVG can embed `<script>` — belt-and-suspenders alongside the browser's own refusal to
  execute script from an SVG loaded via `<img>`, since there's no functional need to preview one
  inline anyway. No new endpoint: the frontend's `media.js` fetches the SAME
  `GET /messages/files/{id}/download` response used for downloads via authenticated `fetch()` +
  `Blob` (a plain `<img src>`/`<video src>` can't carry the Authorization header the endpoint
  requires), caches the resulting `blob:` URL by file id, and only falls back to the plain file
  card if that fetch fails OR the browser's own `<img>`/`<video>`/`<audio>` `error` event fires
  (bytes fetched fine but couldn't actually be decoded as that media type) — the latter is what
  makes an unsupported/corrupt file degrade gracefully instead of showing a broken player.
- **Calls**: `calls` and `call_signaling` are both brand-new tables (see "Audio calling" below
  for the full design) — `create_all()` created them on top of an existing `ping.db` with no
  migration step, same as `message_files` did. `calls.receiver_id` is never taken from the
  client; it's always derived server-side from the calling conversation's other member
  (`call_service.get_other_member_id`), the same "sender is always the verified token, never
  the request body" rule every other write endpoint in this API follows.

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

Unread tracking (above) hit the same `create_all()`-can't-alter-a-table limit when it added
`conversation_members.last_read_at` — but by then `ping.db` held real registered accounts, so
a reset wasn't an option. `backend/main.py` instead runs a small idempotent `ALTER TABLE ...
ADD COLUMN` at startup (checked via `sqlalchemy.inspect()`, so it's a no-op once the column
exists) — additive and safe on every restart, same as `create_all()` itself, just covering the
one case it can't. This is the pattern to reach for first when a future column needs adding to
an existing table; a full Alembic setup is still deliberately not in place (see above).

Reactions needed neither trick: `message_reactions` is a brand new table, not a new column on
an existing one, and `create_all()` handles creating whole new tables (including on a database
that already has real rows in every other table) just fine on its own.

Replies hit the same `create_all()`-can't-alter-a-table limit as `last_read_at` — `messages`
already existed with real rows when `reply_to_message_id` was added — so `main.py` extends the
same idempotent `ALTER TABLE ... ADD COLUMN` step to also cover `messages`. Every pre-existing
message ends up with `reply_to_message_id = NULL`, which is exactly "not a reply" — no backfill
needed, and old messages render exactly as before.

File sharing needed neither trick either, same reasoning as reactions: `message_files` is a
brand new table, so `create_all()` handles it on its own on top of an existing `ping.db`.

Inline media previews needed no schema change at all, not even a new column: `category` is
computed at response time from the existing `mime_type` field (see "Inline media previews"
above), so it required zero migration and works retroactively on files uploaded before it shipped.

## Real-time strategy

No WebSockets yet, by design. Three independent pollers, each owning exactly one timer at a
time (never more than one in flight per poller):

- **`chat.js`** — while a conversation is open, re-fetches and fully *replaces* its message
  list every 5 seconds (`Chat.startPolling()` / `stopPolling()`) — replacing rather than
  appending is what makes a just-sent message immune to ever appearing twice once the next
  poll confirms it from the server. Stops when the conversation closes or on logout. After
  every successful fetch it calls `Conversations.markRead()` if the latest message id is new
  since the last time it did so — that's what keeps an open conversation's unread count at 0
  without a `POST /read` on every single tick.
- **`conversations.js`** — polls `GET /conversations` every `CONVERSATION_POLL_INTERVAL`
  (`config.js`, default 5000ms) to keep the sidebar's ordering, previews, and unread badges
  current (`Conversations.startPolling()` / `stopPolling()`, started once from `init()`,
  stopped on logout). Skips re-rendering when the response is unchanged, and never lets two
  fetches overlap. If a poll ever finds unread messages on the conversation the user is
  actively viewing (a brief race with `chat.js`'s own timer), it clears that badge immediately
  and fires the read confirmation itself rather than flashing it.
- **`calls.js`** — one **adaptive** timer rather than a fixed interval: `CALL_POLL_INTERVAL_IDLE_MS`
  (`config.js`, same value as `CONVERSATION_POLL_INTERVAL`) while idle, just to notice an
  incoming call via `GET /calls/active`; the moment a call exists, it switches to
  `CALL_POLL_INTERVAL_ACTIVE_MS` (1.5s) against `GET /calls/{id}` for fast SDP/ICE signaling
  exchange, and drops back to idle speed the instant the call ends. This is what keeps calling
  from adding a second always-on poll loop alongside the two above — see "Audio calling" below.

All three are written as plain functions (`handleNewMessage`-shaped: fetch, then hand the
result to a render/update function) rather than anything poll-specific, so `startPolling()`/
`stopPolling()` (or, for `calls.js`, `scheduleNextPoll()`) in each file are the intended seam
for a future WebSocket connection to plug into — replacing the timer, not the handlers.

## Audio calling

One-to-one audio calling over WebRTC, with the existing REST/JWT API used only for call
state and WebRTC signaling — never for the audio itself.

- **Signaling, not media, over REST.** `RTCPeerConnection` handles microphone capture and the
  actual peer-to-peer audio stream; the backend only ever relays small JSON blobs (SDP offers/
  answers, ICE candidates) it never inspects (`models.CallSignal.payload` is an opaque JSON
  string) — see `routers/calls.py`'s module docstring. `GET /calls/{id}?after_signal_id=` comes
  back with the call's current status **and** every new signal from the other participant in
  one response, deliberately shaped like a single future WebSocket "call:update" event would be
  — swapping the transport later only touches `calls.js`'s polling functions
  (`scheduleNextPoll`/`pollTick`/`sendSignal`), never `createPeerConnection`/`handleSignal`/the
  overlay itself.
- **State machine**: `calling` → `ringing`/`incoming` → `accepted` → `ended`, or terminated
  early by `rejected`/`cancelled`/`missed`/`busy` (`models.Call.status`, enforced server-side in
  `services/call_service.py` and `routers/calls.py` — a client's own UI state is never trusted
  for a transition). `busy` is set at creation time, not reached via a transition: if either
  the caller or receiver already has a `ringing`/`accepted` call, the new row is created already
  `busy` and finalized, so it never rings the would-be receiver and never appears in their
  `GET /calls/active` poll.
- **Missed-call timeout with no scheduler.** `CALL_RING_TIMEOUT_SECONDS` (`backend/config.py`,
  default 30s) is enforced lazily: `call_service.apply_ring_timeout` checks a `ringing` call's
  age on every read (`GET /calls/active`, `GET /calls/{id}`) and every state-changing action,
  flipping it to `missed` the first time it's read past that age. Idempotent, so a client
  polling every 1.5s only ever sees the transition once — never a repeated missed-call
  notification for the same call.
- **One reusable call UI, two presentations.** `calls.js` drives a single state machine, but
  renders it two ways: `#callOverlay` is a full-screen, blocking panel (same overlay/modal
  pattern as the forward-message modal and image lightbox) for the `calling`/`incoming`
  states and the brief `ended`-phase result notices (declined/missed/busy/failed/ended);
  `#activeCallBar`, a slim fixed bar at the very top of the page, takes over instead once a
  call reaches `connecting`/`connected`. That split exists specifically so the chat — message
  list *and* composer — stays fully usable while a call is actually in progress, per the task
  requirement that sending a message must keep working during an active call; only the
  ringing/incoming decision states are meant to block interaction. `#activeCallBar` lives
  outside `#appShell` (with `.app-shell--call-bar` adding matching `padding-top` so it never
  covers the sidebar/chat header) so it keeps showing even if the user switches conversations
  or closes the chat entirely — the call itself doesn't care which chat view happens to be open.
- **ICE/STUN/TURN is backend-configured, not hardcoded in the frontend.** `GET /calls/ice-servers`
  returns `backend/config.py`'s `get_ice_servers()` output (`ICE_STUN_URLS`, plus an optional
  single TURN server via `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL`) — `calls.js` fetches it
  once per session and falls back to a hardcoded public STUN default only if that request
  itself fails. Adding a TURN server later (needed for NAT/firewall combinations STUN alone
  can't traverse) is purely an env-var change, no code changes on either side.
- **Resource cleanup.** `cleanupRtc()` stops every local `MediaStream` track and closes the
  `RTCPeerConnection` on every path out of a call (hangup, reject, cancel, missed, busy, ICE
  failure, a client-side connect timeout) — `resetToIdle()` always calls it before handing
  control back to the idle poller, so a user can start a new call immediately after any way the
  previous one could have ended.

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
  user input is never treated as markup. Reaction emoji, usernames, and counts follow the
  same rule, including the quoted sender/content shown in a reply's `.message-quote` block
  and in the composer's reply preview.
- Reaction emoji are restricted server-side (`schemas.ALLOWED_REACTION_EMOJIS`) to the same
  8 the picker offers — a direct API call can't stash arbitrary text in what's displayed back
  to every conversation member as an "emoji".
- File uploads (`services/file_service.py`) never trust the client-supplied filename or MIME
  type: the stored path is entirely server-generated (a UUID under `UPLOAD_DIR`, never the
  client's filename), the client's Content-Type header is ignored in favor of a server-side
  guess from the sanitized filename, and a configurable extension blocklist rejects
  executable/script uploads outright. `backend/uploads/` sits outside the frontend/static
  tree and is never mounted as a static directory — the only way to read a file back is
  `GET /messages/files/{id}/download`, which independently re-checks that the caller belongs
  to the file's conversation, same as every other message endpoint.
- Inline media previews reuse that same download endpoint (see "Inline media previews" in
  Data model above) rather than adding a second, less-guarded read path — there is no way to
  view a file's bytes that skips the conversation-membership check. Preview eligibility
  (`MessageFileOut.category`) is a rendering hint only, not a trust decision: a wrongly- or
  maliciously-typed file is still safe to preview, because `<img>`/`<video>`/`<audio>` never
  execute their `src`'s bytes as anything other than that media type — a mismatch just fails to
  render (and is treated as such, falling back to the plain file card) rather than doing
  anything unsafe. `image/svg+xml` is excluded from preview outright since SVG can embed
  `<script>`, even though `<img>` already refuses to execute it.
- Calls follow the same access-control posture as everything else: `POST /calls` requires
  conversation membership and derives the receiver server-side (never from the request body);
  every other call endpoint requires being that specific call's caller or receiver
  (`routers/calls.py`'s `_require_participant`) and returns `403` otherwise — a call id alone
  never grants access, and a third party can't read or inject signaling messages for a call
  they're not on. Every state-changing endpoint (`accept`/`reject`/`cancel`/`hangup`) also
  independently re-checks that the call is still in a state where that transition is legal
  (e.g. `accept` on an already-`missed` call is rejected with `409`), not just who's calling it —
  the frontend's own state is never trusted for this. Busy and the ring timeout are both
  enforced server-side (see "Audio calling" above), not merely assumed from the client.
