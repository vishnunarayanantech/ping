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
