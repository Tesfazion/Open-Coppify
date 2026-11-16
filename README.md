# Coppify

Turn any YouTube link into vertical short clips, entirely locally.

Coppify downloads the video, transcribes it with Whisper, scores candidate moments, and
renders them as vertical clips. No cloud services, no accounts, no watermarks.

## What it does

- Paste a YouTube link and start a job
- Download the video with `yt-dlp`
- Transcribe speech with OpenAI Whisper / faster-whisper
- Score and select the strongest windows rather than cutting fixed intervals
- Render vertical clips with burned-in captions in a choice of styles
- Review clips: keep, discard, trim the in/out points, and inspect the transcript
- Render only the clips you kept
- Save reusable run presets in your browser, alongside persisted defaults, a library of past work, and live progress over SSE

## Quick start

```bash
# 1. Clone and enter the project
cd "C:\Protected File\Real Project\Open Coppify"

# 2. Install backend dependencies
python -m pip install -r backend/requirements.txt

# 3. Install frontend dependencies
npm --prefix frontend install

# 4. Run both servers
npm start
```

Then open:

- Frontend: http://localhost:4041
- Backend API: http://127.0.0.1:5000

## SaaS workspace (foundation in progress)

The local Vite/Flask workflow above remains available. A new Next.js workspace
is being built alongside it as the SaaS source of truth; authentication uses
Auth.js with OIDC, and the PostgreSQL/Prisma schema scopes projects and media
records to workspaces.

From the repository root, install the npm workspace, copy
`apps/web/.env.example` to `apps/web/.env`, configure PostgreSQL, Redis,
S3-compatible storage, and OIDC, then run:

```powershell
npm run db:generate
npm run db:migrate
npm run web
```

See [apps/web/README.md](apps/web/README.md) for environment variables, private
object-storage setup, and the OIDC callback URL. Projects, signed video
uploads, and persistent queue/job APIs are available; the Python processing
worker and transcription/clip workflows are still in development.

## The five screens

The app is five routes rather than one long page, so each stage can be linked to and
reloaded, and a long render has somewhere to report itself.

| Route | Purpose |
|-------|---------|
| `/` | Ingest. Paste a link, optionally override defaults for one run |
| `/jobs/:jobId` | Progress. Live stage, percentage and log over SSE |
| `/jobs/:jobId/clips` | Review. Curation, trimming and transcript for one video |
| `/library` | Every video on disk, grouped by source, with a clip grid |
| `/settings` | Persisted defaults and machine diagnostics |
| `/about` | Licensing, third-party credits and the local-first rationale |

## Project structure

```
Open Coppify/
|-- backend/
|   |-- app.py                  # Flask entrypoint
|   |-- config.py               # Central configuration
|   |-- jobs.py                 # Job registry, SSE listeners, retry
|   |-- selftest.py             # Unit / self tests
|   |-- smoke_test.py           # Import + route smoke tests
|   |-- integration_check.py    # Boots both servers, checks real requests
|   |-- contract_check.py       # Response-shape contract used by the frontend
|   |-- routes/
|   |   `-- api.py              # REST + SSE surface
|   `-- services/
|       |-- downloader.py       # yt-dlp download flow
|       |-- transcriber.py      # Whisper transcription + chunking
|       |-- segmenter.py        # Clip selection + keyword scoring
|       |-- clipper.py          # FFmpeg render, captions, curation
|       |-- projects.py         # On-disk project / history index
|       |-- settings.py         # Persisted user settings
|       `-- ffmpeg_utils.py     # FFmpeg discovery + shim
|-- frontend/
|   |-- index.html              # Dev entrypoint (Vite)
|   |-- vite.config.ts          # Dev proxy to Flask
|   |-- tsconfig.json           # Strict TypeScript config
|   `-- src/
|       |-- main.tsx            # Router entrypoint
|       |-- App.tsx             # Shell + routes
|       |-- index.css           # Tailwind v4 @theme design tokens
|       |-- types.ts            # Shared API types
|       |-- lib/
|       |   |-- api.ts          # Fetch client, ApiError with hints
|       |   |-- format.ts       # Timestamps, durations, video ids
|       |   |-- env.ts          # Backend origin resolution
|       |   `-- cn.ts           # Class-name helper
|       |-- hooks/
|       |   |-- useJobStream.ts # SSE subscription for one job
|       |   `-- useDocumentTitle.ts
|       |-- pages/
|       |   |-- Ingest.tsx
|       |   |-- JobProgress.tsx
|       |   |-- Review.tsx
|       |   |-- Library.tsx
|       |   |-- Settings.tsx
|       |   `-- About.tsx
|       `-- components/
|           |-- AppShell.tsx     # Layout, landmarks, skip link
|           |-- ui.tsx           # Buttons, fields, cards, primitives
|           |-- ClipPlayer.tsx   # Player + trim bar
|           |-- TranscriptPanel.tsx
|           |-- SubtitleManager.tsx
|           |-- PageHeader.tsx
|           |-- SystemBadge.tsx
|           `-- ErrorNote.tsx
|-- static/
|   |-- clips/                  # Generated clips
|   |-- downloads/              # Cached YouTube downloads
|   |-- transcripts/            # Cached Whisper transcripts
|   `-- tmp/                    # Scratch media
|-- package.json                # Root scripts
`-- scripts/
    `-- dev.mjs                 # Parallel backend + frontend launcher
```

## Tech stack

| Layer | Tool |
|-------|------|
| Backend | Flask + flask-cors |
| Download | yt-dlp |
| Transcription | OpenAI Whisper / faster-whisper |
| Video render | FFmpeg (libx264, scale/crop/blur filters) |
| Frontend | React + TypeScript + Vite + react-router-dom |
| Real-time | Server-Sent Events |
| Styling | Tailwind CSS v4 (`@theme` tokens, OKLCH) |

## API surface

Every long-running endpoint returns a job immediately. The frontend follows it over SSE.

### Pipeline

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/download` | Download a YouTube video (job) |
| GET | `/api/download/<job_id>` | Download job status |
| POST | `/api/transcribe` | Generate a timestamped transcript (job) |
| GET | `/api/transcribe/<job_id>` | Transcription job status |
| GET | `/api/transcript/<video_id>` | Cached transcript |
| POST | `/api/clips` | Score, select and render clips (job) |

### Jobs

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/jobs` | Recent jobs |
| GET | `/api/jobs/<id>` | Snapshot for any job type |
| GET | `/api/jobs/<id>/events` | SSE progress stream |
| POST | `/api/jobs/<id>/cancel` | Cancel a running job |
| POST | `/api/jobs/<id>/retry` | Re-run a finished job under a new id |

### Clips

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/clips` | Gallery listing (`?video_id=`, `?limit=`) |
| GET | `/api/clips/job/<id>` | Clips produced by one job |
| GET | `/api/clips/<id>` | One clip |
| PATCH | `/api/clips/<id>` | Trim, keep/discard, retitle (no re-encode) |
| DELETE | `/api/clips/<id>` | Delete a clip and its sidecars |
| POST | `/api/clips/clear` | Clear the gallery |
| GET | `/api/clips/<id>/words` | Word-level timings for the trim bar |
| GET | `/api/clips/<id>/srt` | Sidecar captions |
| POST | `/api/clips/<id>/subtitle` | Upload a custom `.srt` |
| GET | `/api/clips/<id>/download` | Download the file |
| POST | `/api/clips/<id>/render` | Re-encode one clip at a ratio/style (job) |
| POST | `/api/clips/render` | Batch re-render, e.g. every kept clip (job) |

### Videos, library and settings

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects` | Videos on disk, newest first |
| GET | `/api/projects/<video_id>` | One project and its clips |
| GET | `/api/library` | Aggregate counts |
| GET | `/api/video/<video_id>` | Cached video metadata |
| DELETE | `/api/video/<video_id>` | Delete a video and its clips |
| GET | `/api/transcripts` | Cached transcripts |
| GET | `/api/settings` | Saved defaults plus catalogues and limits |
| PUT | `/api/settings` | Partial update, clamped to valid ranges |
| POST | `/api/settings/reset` | Restore defaults |
| GET | `/api/health` | Component diagnostics |
| POST | `/api/models/unload` | Free Whisper models from memory |
| GET | `/api/config` | Public configuration |

Errors carry an `error` message and, where there is a concrete recovery, a `hint`. The
frontend renders both, so a failure states what to do next instead of only what went wrong.

## Clip selection logic

Coppify does not cut fixed windows. It scores candidates using:

1. **Keyword density** — how often requested terms appear
2. **Speech density** — words per second versus the video median
3. **Boundary quality** — prefers clean sentence starts and ends
4. **Length fit** — rewards windows close to the target length
5. **Position** — penalises intros and outros

Candidates are then selected greedily with a minimum gap, so the gallery never shows five
variations of the same forty seconds. Every clip records the reasons behind its score, which
the review screen shows on the "Why this cut" tab.

## Configuration

Static tunables live in `backend/config.py` and can be overridden by environment variable.
Grouped by area, the ones worth knowing:

| Variable | Default | Purpose |
|----------|---------|---------|
| `COPPIFY_HOST` | `127.0.0.1` | Bind address |
| `COPPIFY_PORT` | `5000` | API port |
| `COPPIFY_DEBUG` | `false` | Flask debug mode |
| `COPPIFY_CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `COPPIFY_MAX_JOBS` | `200` | Jobs kept in memory |
| `COPPIFY_JOB_RETENTION` | `21600` | Seconds a finished job stays readable |
| `COPPIFY_MAX_HEIGHT` | `1080` | Cap on downloaded video height |
| `COPPIFY_YTDLP_COOKIES` | – | `yt-dlp` source for browser cookies (e.g. `firefox`) |
| `COPPIFY_YTDLP_JS_RUNTIME` | – | JS runtime for `yt-dlp` EJS (e.g. `node`) |
| `COPPIFY_WHISPER_MODEL` | `base` | `tiny` … `large-v3` |
| `COPPIFY_WHISPER_LANGUAGE` | auto | Force a language |
| `COPPIFY_WHISPER_DEVICE` | `auto` | `cpu`, `cuda` or `auto` |
| `COPPIFY_CLIP_MIN_SECONDS` | `30` | Shortest clip |
| `COPPIFY_CLIP_MAX_SECONDS` | `60` | Longest clip |
| `COPPIFY_CLIP_TARGET_SECONDS` | `45` | Preferred clip length |
| `COPPIFY_CLIP_COUNT` | `5` | Default number of clips |
| `COPPIFY_CLIP_MIN_GAP` | `15` | Minimum gap between two clips |
| `COPPIFY_CLIP_EDGE_TRIM` | `8` | Seconds ignored at start/end |
| `COPPIFY_VERTICAL_WIDTH` | `1080` | Output width |
| `COPPIFY_VERTICAL_HEIGHT` | `1920` | Output height |
| `COPPIFY_VERTICAL_MODE` | `blur` | `blur`, `crop` or `fit` |
| `COPPIFY_CLIP_CRF` | `23` | x264 quality |
| `COPPIFY_CLIP_PRESET` | `veryfast` | x264 preset |
| `COPPIFY_WRITE_SRT` | `false` | Also write an `.srt` sidecar |
| `COPPIFY_KEEP_DOWNLOADS` | `true` | Keep source videos on disk |
| `COPPIFY_MAX_UPLOAD_MB` | `2048` | Subtitle upload cap |

User-facing defaults — clip count, length window, keywords, framing, aspect ratio, caption
style, Whisper model — are editable on the Settings screen and stored in
`static/settings.json`. Invalid values are clamped rather than rejected, so a hand-edited
file cannot break startup. The clip manifest lives at `static/clips/manifest.json`.

In development the Vite dev server proxies `/api`, `/static` and `/clips` to
`http://127.0.0.1:5000`, so the browser talks to the API same-origin and CORS never
applies. For a deployed build, set `VITE_API_URL` to the backend's absolute URL.

## Development

```bash
# Backend only
python backend/app.py

# Frontend only
npm --prefix frontend start

# Production build
npm --prefix frontend run build

# Type check
npm --prefix frontend run typecheck

# Tests
python backend/selftest.py           # unit / self
python backend/smoke_test.py         # imports + routes
python backend/contract_check.py     # frontend-facing response shapes
python backend/integration_check.py  # boots both servers, real requests
npm test                             # all of the above
```

`integration_check.py` asserts that every frontend module transforms under the dev server.
That is deliberate: the production build starts from `main.tsx` and will pass even if a
deleted file is still imported somewhere in the tree, while the dev server has to resolve
every module in the graph.

### Frontend architecture

- **TypeScript, strict.** The app is `.tsx`/`.ts` throughout; `tsc --noEmit` runs before
  every production build and as its own `npm run typecheck`. Shared API shapes live in
  `src/types.ts`.
- **Tailwind CSS v4.** Design tokens are declared once in `src/index.css` under `@theme`
  (OKLCH colour scales, fonts, radii). Components compose utility classes rather than
  per-screen stylesheets; reusable primitives are in `src/components/ui.tsx`.
- **Typed data layer.** `src/lib/api.ts` is a thin `fetch` client that normalises failures
  into an `ApiError` carrying the backend's `error` and `hint`. `src/lib/format.ts` owns all
  timestamp/duration formatting.
- **Same-origin in dev.** `vite.config.ts` proxies `/api`, `/static` and `/clips` to Flask,
  so there are no CORS surprises locally and no absolute URLs baked into components.
- **Accessibility (WCAG 2.2 AA).** Semantic landmarks, a skip link, labelled controls,
  visible focus rings, AA-contrast text tokens and `prefers-reduced-motion` handling are
  built into `AppShell` and the primitives, not bolted on per page.
- **Licensing and credits.** Third-party licences (bundled fonts, runtime dependencies) are
  surfaced on the `/about` route rather than buried in a file.

## Notes

- `ffprobe` is not required; Coppify probes media by parsing `ffmpeg -i` output.
- MoviePy is listed in `requirements.txt` only to locate a bundled FFmpeg binary. Actual
  rendering uses direct FFmpeg subprocess calls for speed and progress accuracy.
- Generated media is git-ignored via `.gitignore`, with folder structure preserved by
  `.gitkeep` files.
- `PATCH /api/clips/<id>` deliberately does not re-encode. Trimming should feel instant; the
  encode is requested separately as a job so it reports progress and can be retried.
- SSE holds a thread per open stream. That is fine for the Flask dev server serving a single
  operator; behind a real WSGI server, confirm the worker class is threaded.
