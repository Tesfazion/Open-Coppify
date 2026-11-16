"""Ad-hoc contract check: the frontend was rewritten against these payloads.

Verifies real dispatch (not just route registration) and the exact keys each
screen reads. A route existing is not the same as it being reachable, and a
missing key here is an undefined in the UI rather than an exception.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app  # noqa: E402

app = create_app({"TESTING": True})
client = app.test_client()

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


print("settings")
r = client.get("/api/settings")
check("GET /api/settings 200", r.status_code == 200, r.status_code)
data = r.get_json() or {}
check("has settings", isinstance(data.get("settings"), dict), list(data))
s = data.get("settings") or {}
for key in (
    "clip_count", "min_seconds", "max_seconds", "target_seconds", "vertical_mode",
    "captions", "auto_transcribe", "whisper_model", "aspect_ratio", "caption_style",
    "keywords",
):
    check(f"settings.{key}", key in s, sorted(s))
check("aspect_ratios is list", isinstance(data.get("aspect_ratios"), list), data.get("aspect_ratios"))
check("vertical_modes is list", isinstance(data.get("vertical_modes"), list), data.get("vertical_modes"))
check("caption_styles is list", isinstance(data.get("caption_styles"), list), data.get("caption_styles"))
check("whisper_models is list", isinstance(data.get("whisper_models"), list), data.get("whisper_models"))

print("projects")
r = client.get("/api/projects")
check("GET /api/projects 200", r.status_code == 200, r.status_code)
check("has projects list", isinstance((r.get_json() or {}).get("projects"), list))
r = client.get("/api/library")
check("GET /api/library 200", r.status_code == 200, r.status_code)
check("has summary", isinstance((r.get_json() or {}).get("summary"), dict))

print("clips")
r = client.get("/api/clips")
check("GET /api/clips 200", r.status_code == 200, r.status_code)
check("has clips list", isinstance((r.get_json() or {}).get("clips"), list))

print("dispatch: /api/clips/job/<id> must not be read as a clip id")
r = client.get("/api/clips/job/definitely-not-a-real-job")
check("unknown job -> 404 (not 500)", r.status_code == 404, r.status_code)

print("dispatch: /api/clips/clear must not be read as a clip id")
r = client.post("/api/clips/clear")
check("POST /api/clips/clear not 404", r.status_code != 404, r.status_code)

print("dispatch: batch render route")
r = client.post("/api/clips/render", json={})
check("POST /api/clips/render 400/404/202, not 405", r.status_code != 405, r.status_code)

print("unknown clip")
r = client.get("/api/clips/not-a-real-clip")
check("GET unknown clip -> 404", r.status_code == 404, r.status_code)
r = client.patch("/api/clips/not-a-real-clip", json={"status": "kept"})
check("PATCH unknown clip -> 404", r.status_code == 404, r.status_code)

print("jobs")
r = client.get("/api/jobs/nope")
check("GET unknown job -> 404", r.status_code == 404, r.status_code)
r = client.get("/api/jobs/nope/events")
check("GET unknown job events -> 404", r.status_code == 404, r.status_code)
r = client.post("/api/jobs/nope/retry")
check("POST unknown retry -> 404", r.status_code == 404, r.status_code)

print("health")
r = client.get("/api/health")
check("GET /api/health 200", r.status_code == 200, r.status_code)
h = r.get_json() or {}
for key in ("ffmpeg", "whisper", "ytdlp_version", "clips_on_disk"):
    check(f"health.{key}", key in h, sorted(h))
check("health.ffmpeg.ok present", "ok" in (h.get("ffmpeg") or {}))

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all contract checks passed")
