/**
 * Global frontend configuration.
 * - Change `appName` / `tagline` here to rebrand the whole app — every
 *   page pulls these from this file instead of hardcoding text.
 * - Change `API_BASE_URL` if the backend runs on a different host/port.
 */
const APP_CONFIG = {
  appName: 'PING',
  tagline: 'Work. Talk. PING.',
  minPasswordLength: 8,
  simulatedNetworkDelay: 1400 // ms, used by the still-unwired demo pages (forgot/reset password)
};

const API_BASE_URL = 'http://127.0.0.1:8000/api/v1';

// How often the sidebar re-fetches /conversations to catch new messages
// (unread counts, ordering, previews) while no WebSocket connection exists.
const CONVERSATION_POLL_INTERVAL = 5000;

// Mirrors backend/config.py's MAX_UPLOAD_SIZE_MB default — used only to
// reject an oversized file before spending time uploading it; the backend
// enforces its own configured limit regardless of what this says.
const MAX_UPLOAD_SIZE_MB = 25;

// Mirrors backend/config.py's MAX_AVATAR_SIZE_MB default — same "just a
// pre-flight check" caveat as MAX_UPLOAD_SIZE_MB above.
const MAX_AVATAR_SIZE_MB = 5;

// Audio calling (see calls.js). Two speeds for the SAME single poll timer,
// not two separate timers: while idle, checking for an incoming call only
// needs to be as fresh as the sidebar's own poll; once a call is actually
// ringing/connecting, SDP/ICE signaling needs to move much faster than a
// 5s tick would allow, or call setup feels broken.
const CALL_POLL_INTERVAL_IDLE_MS = CONVERSATION_POLL_INTERVAL;
const CALL_POLL_INTERVAL_ACTIVE_MS = 1500;

// A stuck ICE negotiation (e.g. a NAT neither side's STUN can traverse, with
// no TURN server configured yet — see backend/config.py's TURN_* env vars)
// would otherwise leave the UI in "Connecting…" forever. Client-side only;
// backend/config.py's CALL_RING_TIMEOUT_SECONDS is the server-enforced
// equivalent for the earlier "ringing, nobody answered" phase.
const CALL_CONNECT_TIMEOUT_MS = 20000;

// Used only if GET /calls/ice-servers can't be reached — backend/config.py's
// ICE_STUN_URLS/TURN_* env vars are the real source of truth.
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Screen sharing (see calls.js) renegotiates the existing peer connection
// rather than opening a new one — this bounds how long that one extra
// offer/answer round trip is allowed to take before it's treated as failed
// (independent of CALL_CONNECT_TIMEOUT_MS, which only covers the original
// call setup) so a lost renegotiation signal can't leave the "Share Screen"
// button stuck disabled forever.
const CALL_RENEGOTIATION_TIMEOUT_MS = 15000;

// A page refresh (or a genuine transient network drop) makes the OTHER
// participant's ICE connection report 'disconnected'/'failed' with no
// explicit hangup ever sent — see calls.js's "Surviving a page refresh"
// docstring. This bounds how long that side waits (showing "Reconnecting…")
// for either ICE to self-recover or a fresh offer from a peer who just
// resumed after their own reload, before giving up and treating it as a
// genuine failure — independent of CALL_CONNECT_TIMEOUT_MS, which only
// covers the very first handshake before a call ever connects.
const CALL_RECONNECT_GRACE_MS = 20000;

// Group audio calling (see groupcalls.js) — a SEPARATE poll loop from
// calls.js's (one-to-one calling and group calling are independent
// features that can't overlap for one user — see groupcalls.js's module
// docstring), but reusing the exact same two-speed idea: slow while idle
// (just checking for an invitation), fast once actually in a call.
const GROUP_CALL_POLL_INTERVAL_IDLE_MS = CONVERSATION_POLL_INTERVAL;
const GROUP_CALL_POLL_INTERVAL_ACTIVE_MS = 1500;

// Mirrors backend/config.py's GROUP_CALL_MAX_PARTICIPANTS default — same
// "just a pre-flight UI check" caveat as MAX_UPLOAD_SIZE_MB above: the
// backend enforces the real limit regardless of what this says.
const GROUP_CALL_MAX_PARTICIPANTS = 6;
