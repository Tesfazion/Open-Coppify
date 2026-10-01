"""End-to-end integration check: real backend + real Vite dev server.

Starts ``python app.py`` and ``npm start`` as separate processes (exactly how the
user runs them), then verifies the front end is served, that the JSX module graph
transforms without error, and that the browser's cross-origin call from
http://localhost:3000 to the Flask API is permitted.

Run with:  python backend/integration_check.py
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
BACKEND_PORT = 5098
FRONTEND_PORT = 3000
API = f"http://127.0.0.1:{BACKEND_PORT}"
WEB = f"http://localhost:{FRONTEND_PORT}"

PASSED = 0
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASSED
    if ok:
        PASSED += 1
        print(f"  PASS  {name}")
    else:
        FAILED.append(name)
        print(f"  FAIL  {name}" + (f" -- {detail}" if detail else ""))


def wait_for(url: str, *, timeout: float = 90.0, expect: int = 200):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            response = requests.get(url, timeout=4)
            last = response.status_code
            if response.status_code == expect:
                return response
        except requests.RequestException:
            time.sleep(0.4)
    raise TimeoutError(f"{url} never returned {expect} (last={last})")


def main() -> int:
    print("=" * 66)
    print("Coppify integration check (backend + Vite dev server)")
    print("=" * 66)

    backend = subprocess.Popen(
        [sys.executable, "app.py", "--port", str(BACKEND_PORT), "--no-reload"],
        cwd=str(ROOT / "backend"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    frontend = subprocess.Popen(
        ["npm", "start"],
        cwd=str(FRONTEND),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=True,
    )

    try:
        print("\n[1] Backend boots via `python app.py`")
        health = wait_for(f"{API}/api/health").json()
        check("health reachable", health.get("ok") is True)
        check("ffmpeg ok", health["ffmpeg"]["ok"] is True)
        check("whisper ok", health["whisper"]["ok"] is True)
        check("yt-dlp present", bool(health.get("ytdlp_version")))
        check("9:16 output config", health["output"] == {
            "width": 1080, "height": 1920, "aspect_ratio": "9:16"}, str(health["output"]))

        print("\n[2] Frontend boots via `npm start`")
        page = wait_for(WEB).text
        check("index.html served", "<div id=\"root\"></div>" in page)
        check("references /src/main.jsx", "/src/main.jsx" in page)

        # The dev server must transform every module the app imports.
        for module, needle in [
            ("/src/main.jsx", "react"),
            ("/src/App.jsx", "ClipGallery"),
            ("/src/api.js", "axios"),
            ("/src/hooks/useJob.js", "getJob"),
            ("/src/components/ClipGallery.jsx", "clip__frame"),
            ("/src/components/OptionsPanel.jsx", "verticalMode"),
            ("/src/components/ProgressPanel.jsx", "progressbar"),
            ("/src/components/TranscriptPanel.jsx", "Transcript"),
            ("/src/components/HealthBar.jsx", "health"),
            ("/src/components/UrlForm.jsx", "youtube-url"),
            ("/src/utils/youtube.js", "extractVideoId"),
        ]:
            response = requests.get(f"{WEB}{module}", timeout=20)
            body = response.text
            ok = response.status_code == 200 and needle in body
            check(f"module {module} transforms", ok,
                  f"status={response.status_code}")

        print("\n[3] Cross-origin request from the dev server origin")
        preflight = requests.options(
            f"{API}/api/clips",
            headers={
                "Origin": WEB,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
            timeout=30,
        )
        check("preflight succeeds",
              preflight.status_code in {200, 204}, str(preflight.status_code))
        check("allows localhost:3000",
              preflight.headers.get("Access-Control-Allow-Origin") in {WEB, "*"},
              preflight.headers.get("Access-Control-Allow-Origin", "<none>"))

        actual = requests.get(f"{API}/api/health",
                              headers={"Origin": WEB}, timeout=30)
        check("GET carries ACAO header",
              actual.headers.get("Access-Control-Allow-Origin") in {WEB, "*"},
              actual.headers.get("Access-Control-Allow-Origin", "<none>"))

        print("\n[4] API rejects bad input from that origin")
        rejected = requests.post(f"{API}/api/download",
                                 json={"url": "https://example.com/video"},
                                 headers={"Origin": WEB}, timeout=30)
        check("bad URL rejected with 400", rejected.status_code == 400,
              str(rejected.status_code))

    finally:
        for name, process in (("backend", backend), ("frontend", frontend)):
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        print("\n[cleanup] stopped both servers")

    print("\n" + "=" * 66)
    print(f"passed: {PASSED}   failed: {len(FAILED)}")
    for name in FAILED:
        print(f"  - {name}")
    print("=" * 66)
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())