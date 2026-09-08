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
