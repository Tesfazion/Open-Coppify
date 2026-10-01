"""Coppify backend -- Flask application factory and entrypoint.

Run it with::

    python app.py            # from inside backend/
    python backend/app.py     # from the project root

The dev server binds 127.0.0.1:5000 by default and serves the generated clips
from ``static/clips`` so the React app can preview and download them directly.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

# Allow both `python app.py` and `python backend/app.py`.
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from flask import Flask, jsonify, send_from_directory  # noqa: E402
from flask_cors import CORS  # noqa: E402

from config import (  # noqa: E402
    CLIPS_DIR,
    CORS_ORIGINS,
    DEBUG,
    HOST,
    PORT,
    PROJECT_ROOT,
    STORAGE_DIR,
)
from routes.api import register_routes  # noqa: E402
from services import ffmpeg_utils  # noqa: E402

LOG_FORMAT = "%(asctime)s  %(levelname)-7s %(name)s: %(message)s"


def create_app(config_overrides: dict | None = None) -> Flask:
    app = Flask(
        __name__,
        static_folder=str(STORAGE_DIR),
        static_url_path="/static",
    )
    app.config.update(
        JSON_SORT_KEYS=False,
        MAX_CONTENT_LENGTH=None,
        SEND_FILE_MAX_AGE_DEFAULT=0,
    )
    if config_overrides:
        app.config.update(config_overrides)

    # The Vite dev server runs on a different port, so CORS is required.
    # flask-cors handles the "*" case and preflight automatically.
    CORS(
        app,
        resources={r"/api/*": {"origins": CORS_ORIGINS}},
        supports_credentials=False,
    )

    register_routes(app)

    _register_static_clip_routes(app)
    _register_error_handlers(app)

    # Touch FFmpeg early so the first /api/health call is not the thing that
    # discovers a broken install.
    try:
        ffmpeg_utils.ffmpeg_path()
    except ffmpeg_utils.FfmpegNotFound as exc:
        app.logger.warning("FFmpeg not available: %s", exc)

    return app


def _register_static_clip_routes(app: Flask) -> None:
    """Explicit 9:16 clip routes in addition to Flask's generic /static."""

    @app.get("/static/clips/<path:filename>")
    def serve_clip(filename: str):
        if not filename.endswith(".mp4"):
            return send_from_directory(CLIPS_DIR, filename)
        response = send_from_directory(CLIPS_DIR, filename, conditional=True)
        # Let the browser cache posters hard but never cache the mp4 itself.
        response.cache_control.max_age = 3600
        return response

    @app.get("/clips/<path:filename>")
    def serve_clip_short(filename: str):
        """Convenience alias so /clips/x.mp4 works without /static."""
        return send_from_directory(CLIPS_DIR, filename, conditional=True)


def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(404)
    def not_found(_error):
        if _wants_json():
            return jsonify({"ok": False, "error": "Not found"}), 404
        return "Not found", 404

    @app.errorhandler(405)
    def method_not_allowed(_error):
        return jsonify({"ok": False, "error": "Method not allowed"}), 405

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify({"ok": False, "error": "Payload too large"}), 413

    @app.errorhandler(500)
    def server_error(error):  # pragma: no cover - defensive
        app.logger.exception("Unhandled server error")
        return jsonify({"ok": False, "error": f"Internal error: {error}"}), 500


def _wants_json() -> bool:
    from flask import request

    return request.path.startswith("/api/") or request.accept_mimetypes.best == "application/json"


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Coppify Flask backend")
    parser.add_argument("--host", default=HOST, help=f"bind address (default {HOST})")
    parser.add_argument("--port", type=int, default=PORT,
                        help=f"bind port (default {PORT})")
    parser.add_argument("--debug", action="store_true", default=DEBUG,
                        help="enable the reloader and debugger")
    parser.add_argument("--no-reload", action="store_true",
                        help="disable the auto-reloader (cleaner for scripting)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    logger = logging.getLogger("coppify")

    # Threaded so a long FFmpeg encode does not block /api/health polling.
    app = create_app()

    logger.info("Coppify backend starting")
    logger.info("  project root : %s", PROJECT_ROOT)
    logger.info("  clips folder : %s", CLIPS_DIR)
    try:
        logger.info("  ffmpeg       : %s", ffmpeg_utils.ffmpeg_version())
    except ffmpeg_utils.FfmpegNotFound as exc:
        logger.error("  ffmpeg       : MISSING -- %s", exc)
    logger.info("  listening on : http://%s:%s", args.host, args.port)
    logger.info("  frontend dev : http://localhost:3000 (run `npm start` in frontend/)")

    app.run(
        host=args.host,
        port=args.port,
        debug=args.debug,
        use_reloader=args.debug and not args.no_reload,
        threaded=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())