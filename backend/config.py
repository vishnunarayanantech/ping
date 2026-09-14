"""
File-upload settings, kept separate from database.py since these govern the
filesystem side of file sharing (not the DB). All configurable via
environment variables (.env) so a deployment can move the upload directory
or change the size cap without touching code — see .env.example.
"""
import os

from dotenv import load_dotenv

load_dotenv()

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

# Deliberately OUTSIDE the frontend/static source tree and never mounted as
# a static directory — the only way to read an uploaded file back is
# through the authenticated download endpoint in routers/messages.py.
UPLOAD_DIR = os.getenv("UPLOAD_DIR", os.path.join(_BACKEND_DIR, "uploads"))

MAX_UPLOAD_SIZE_MB = float(os.getenv("MAX_UPLOAD_SIZE_MB", "25"))
MAX_UPLOAD_SIZE_BYTES = int(MAX_UPLOAD_SIZE_MB * 1024 * 1024)

# Extensions rejected outright regardless of what the client claims as the
# MIME type — defense in depth against sharing directly-executable content
# through chat. Comma-separated override via env, e.g.
# BLOCKED_UPLOAD_EXTENSIONS=.exe,.bat
_DEFAULT_BLOCKED_EXTENSIONS = (
    ".exe,.dll,.bat,.cmd,.com,.msi,.scr,.ps1,.psm1,.sh,.bash,.jar,.jsp,"
    ".php,.php3,.php4,.php5,.phtml,.pl,.py,.pyc,.rb,.vbs,.vbe,.wsf,.wsh,.app,.apk"
)
BLOCKED_UPLOAD_EXTENSIONS = {
    ext.strip().lower()
    for ext in os.getenv("BLOCKED_UPLOAD_EXTENSIONS", _DEFAULT_BLOCKED_EXTENSIONS).split(",")
    if ext.strip()
}

os.makedirs(UPLOAD_DIR, exist_ok=True)

# Avatars get their OWN subdirectory, never mixed with conversation
# file-share uploads above — see services/avatar_service.py.
AVATAR_DIR = os.getenv("AVATAR_DIR", os.path.join(UPLOAD_DIR, "avatars"))

MAX_AVATAR_SIZE_MB = float(os.getenv("MAX_AVATAR_SIZE_MB", "5"))
MAX_AVATAR_SIZE_BYTES = int(MAX_AVATAR_SIZE_MB * 1024 * 1024)

# Every avatar is normalized to a single square JPEG at this max dimension
# (see avatar_service._square_crop_and_resize) regardless of how large the
# uploaded source image was — bounds both storage use and the payload every
# avatar view downloads, per the task's "prevent excessively large images
# from consuming storage" requirement.
AVATAR_MAX_DIMENSION = int(os.getenv("AVATAR_MAX_DIMENSION", "512"))

os.makedirs(AVATAR_DIR, exist_ok=True)

# --- Audio calling ------------------------------------------------------
# How long an outgoing call is allowed to sit in "ringing" before
# services/call_service.apply_ring_timeout lazily flips it to "missed".
# Enforced server-side on every read of a call (never trusted from the
# frontend) so a caller can't be left staring at "Calling..." forever just
# because their own tab's timer got throttled or closed.
CALL_RING_TIMEOUT_SECONDS = int(os.getenv("CALL_RING_TIMEOUT_SECONDS", "30"))

# STUN servers offered to the frontend's RTCPeerConnection — comma-separated,
# e.g. "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302". STUN
# alone doesn't guarantee connectivity across every NAT/firewall; a TURN
# relay can be added later purely via the TURN_* env vars below, with zero
# code changes to the frontend or to routers/calls.py.
ICE_STUN_URLS = os.getenv("ICE_STUN_URLS", "stun:stun.l.google.com:19302")

# Optional single TURN server. All three must be set for it to be included
# (a TURN server with no credentials isn't usable) — see get_ice_servers().
TURN_URL = os.getenv("TURN_URL", "")
TURN_USERNAME = os.getenv("TURN_USERNAME", "")
TURN_CREDENTIAL = os.getenv("TURN_CREDENTIAL", "")


def get_ice_servers():
    """RTCPeerConnection-ready iceServers list — see routers/calls.py's
    GET /calls/ice-servers, the frontend's single source of truth for this
    (calls.js never hardcodes a STUN/TURN URL itself)."""
    servers = [{"urls": url.strip()} for url in ICE_STUN_URLS.split(",") if url.strip()]
    if TURN_URL and TURN_USERNAME and TURN_CREDENTIAL:
        servers.append({"urls": TURN_URL, "username": TURN_USERNAME, "credential": TURN_CREDENTIAL})
    return servers


# --- Group audio calling --------------------------------------------------
# Hard cap on total participants (including the creator) in one group call,
# enforced server-side in services/call_service.create_group_call — never
# just hidden behind a disabled frontend button. This first implementation
# is a full mesh (see groupcalls.js's module docstring): every participant
# opens one RTCPeerConnection to every OTHER participant, so the number of
# simultaneous connections/streams grows as N*(N-1) — fine at this size, not
# something a browser (or the "one polling loop dispatches to N peers"
# design) should be asked to do at meeting-sized N. A larger limit would
# need an SFU (a media server every participant sends ONE stream to, which
# then fans it out) instead of this mesh — out of scope for this iteration.
GROUP_CALL_MAX_PARTICIPANTS = int(os.getenv("GROUP_CALL_MAX_PARTICIPANTS", "6"))
