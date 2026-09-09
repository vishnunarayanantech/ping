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
