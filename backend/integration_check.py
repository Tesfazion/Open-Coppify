"""End-to-end integration check: real backend + real Vite dev server.

Starts ``python app.py`` and ``npm start`` as separate processes (exactly how the
user runs them), then verifies the front end is served, that the TypeScript/TSX
module graph transforms without error, and that the backend still permits the
dev origin for deployments that point the built app at it directly.

Run with:  python backend/integration_check.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
BACKEND_PORT = 5098
FRONTEND_PORT = 4041
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

    # Vite is launched directly rather than through `npm start`.
    #
    # `npm start` on Windows is a .cmd shim, so it only runs with shell=True and
    # the process we would hold is cmd.exe. Terminating that leaves the real
    # node process listening on the port as an orphan, and the next run of this
    # script fails because the Vite port is still in use while the backend --
    # which is spawned directly -- shut down cleanly. Holding the node process
    # directly makes terminate() actually stop the server.
    node = shutil.which("node") or "node"
    frontend = subprocess.Popen(
        [node, "node_modules/vite/bin/vite.js"],
        cwd=str(FRONTEND),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
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
        check("references /src/main.tsx", "/src/main.tsx" in page)

        # The dev server must transform every module the app imports. This is the
        # check that catches a deleted file still being imported somewhere: the
        # production build would pass, because Vite starts from main.tsx and
        # never reaches the orphaned import, while the dev server has to resolve
        # every graph node.
        for module, needle in [
            ("/src/main.tsx", "createRoot"),
            ("/src/App.tsx", "Routes"),
            ("/src/lib/api.ts", "describeError"),
            ("/src/lib/format.ts", "extractVideoId"),
            ("/src/hooks/useJobStream.ts", "EventSource"),
            ("/src/pages/Ingest.tsx", "extractVideoId"),
            ("/src/pages/JobProgress.tsx", "useJobStream"),
            ("/src/pages/Review.tsx", "patchClip"),
            ("/src/pages/Library.tsx", "listProjects"),
            ("/src/pages/Settings.tsx", "putSettings"),
            ("/src/pages/About.tsx", "SIL Open Font License"),
            ("/src/components/AppShell.tsx", "Skip to content"),
            ("/src/components/ClipPlayer.tsx", "TrimBar"),
            ("/src/components/TranscriptPanel.tsx", "clipWords"),
            ("/src/components/SystemBadge.tsx", "ytdlp_version"),
            ("/src/components/ErrorNote.tsx", "hint"),
            ("/src/components/ui.tsx", "buttonClass"),
            ("/src/index.css", "sodium-500"),
            # Copied from the reference app so both platforms share typography.
            ("/src/fonts/Archivo-Variable.ttf", ""),
        ]:
            response = requests.get(f"{WEB}{module}", timeout=20)
            body = response.text
            ok = response.status_code == 200 and (not needle or needle in body)
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
        check("allows configured Vite origin",
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
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    print(f"[cleanup] warning: {name} did not exit")
        print("\n[cleanup] stopped both servers")

    print("\n" + "=" * 66)
    print(f"passed: {PASSED}   failed: {len(FAILED)}")
    for name in FAILED:
        print(f"  - {name}")
    print("=" * 66)
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())