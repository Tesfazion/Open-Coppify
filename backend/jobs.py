"""In-memory job registry with progress reporting.

Every long-running operation (download, transcribe, clip render) runs on a
background thread and publishes a monotonic ``progress`` percentage plus a
human-readable ``stage`` string. The React frontend polls ``GET /api/jobs/<id>``
and renders that as a progress bar.

A single global lock guards the registry; individual jobs also carry their own
condition variable so waiters can block until they finish.
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

from config import JOB_RETENTION_SECONDS, MAX_TRACKED_JOBS

QUEUED = "queued"
RUNNING = "running"
SUCCEEDED = "succeeded"
FAILED = "failed"
CANCELLED = "cancelled"

TERMINAL_STATES = {SUCCEEDED, FAILED, CANCELLED}

# Keep the tail of the log so the UI can show what happened without unbounded growth.
MAX_LOG_LINES = 200


class JobCancelled(RuntimeError):
    """Raised inside a worker when cancellation has been requested."""


@dataclass
class Job:
    id: str
    type: str
    status: str = QUEUED
    progress: float = 0.0
    stage: str = "Queued"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    params: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] | None = None
    error: str | None = None
    logs: list[dict[str, Any]] = field(default_factory=list)
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)
    _done: threading.Event = field(default_factory=threading.Event, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # -- mutation helpers ---------------------------------------------------
    def _touch(self) -> None:
        self.updated_at = time.time()

    def add_log(self, message: str, level: str = "info") -> None:
        with self._lock:
            self.logs.append(
                {"ts": round(time.time(), 3), "level": level, "message": str(message)}
            )
            if len(self.logs) > MAX_LOG_LINES:
                del self.logs[: len(self.logs) - MAX_LOG_LINES]
        self._touch()

    def set_progress(self, percent: float, stage: str | None = None) -> None:
        with self._lock:
            self.progress = max(0.0, min(100.0, float(percent)))
            if stage:
                self.stage = str(stage)
        self._touch()

    def to_dict(self, include_logs: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "type": self.type,
            "status": self.status,
            "progress": round(float(self.progress), 2),
            "stage": self.stage,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "finished_at": self.finished_at,
            "params": self.params,
            "result": self.result,
            "error": self.error,
            "elapsed": round(
                (self.finished_at or time.time()) - self.created_at, 2
            ),
        }
        if include_logs:
            payload["logs"] = list(self.logs)
        return payload


class JobContext:
    """Handle passed to a worker function for progress reporting + cancellation."""

    def __init__(self, job: Job):
        self._job = job

    @property
    def job_id(self) -> str:
        return self._job.id

    @property
    def params(self) -> dict[str, Any]:
        return self._job.params

    def log(self, message: str, level: str = "info") -> None:
        self._job.add_log(message, level)

    def progress(self, percent: float, stage: str | None = None) -> None:
        self._job.set_progress(percent, stage)

    def stage(self, message: str) -> None:
        self._job.set_progress(self._job.progress, message)

    def check_cancelled(self) -> None:
        if self._job._cancel.is_set():
            raise JobCancelled("Cancelled by user")

    def is_cancelled(self) -> bool:
        return self._job._cancel.is_set()

    def wait(self, timeout: float | None = None) -> bool:
        return self._job._done.wait(timeout)


class JobStore:
    def __init__(self, max_jobs: int = MAX_TRACKED_JOBS):
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._lock = threading.Lock()

    # -- CRUD ---------------------------------------------------------------
    def create(self, job_type: str, params: dict[str, Any] | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:16], type=job_type, params=params or {})
        with self._lock:
            self._jobs[job.id] = job
            self._evict_locked()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self, job_type: str | None = None) -> list[Job]:
        with self._lock:
            jobs = list(self._jobs.values())
        if job_type:
            jobs = [job for job in jobs if job.type == job_type]
        return jobs

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.status in TERMINAL_STATES:
            return False
        job._cancel.set()
        job.add_log("Cancellation requested", "warn")
        return True

    # -- internals ----------------------------------------------------------
    def _evict_locked(self) -> None:
        now = time.time()
        for job_id, job in list(self._jobs.items()):
            if job.finished_at and now - job.finished_at > JOB_RETENTION_SECONDS:
                del self._jobs[job_id]
        while len(self._jobs) > MAX_TRACKED_JOBS:
            finished = [
                (jid, j)
                for jid, j in self._jobs.items()
                if j.status in TERMINAL_STATES
            ]
            if not finished:
                break
            oldest = min(finished, key=lambda item: item[1].finished_at or 0)[0]
            del self._jobs[oldest]

    def _finalize(self, job: Job) -> None:
        with self._lock:
            self._evict_locked()

    def submit(
        self,
        job_type: str,
        worker: Callable[[JobContext], dict[str, Any]],
        params: dict[str, Any] | None = None,
    ) -> Job:
        """Create a job and run ``worker(ctx)`` on a daemon thread."""
        job = self.create(job_type, params)
        ctx = JobContext(job)

        def _run() -> None:
            job.status = RUNNING
            job.set_progress(1.0, "Starting")
            job.add_log(f"{job_type} job started")
            try:
                result = worker(ctx) or {}
                if job._cancel.is_set():
                    job.status = CANCELLED
                    job.stage = "Cancelled"
                else:
                    job.status = SUCCEEDED
                    job.result = result
                    job.set_progress(100.0, "Done")
                job.add_log(f"{job_type} job {job.status}")
            except JobCancelled as exc:
                job.status = CANCELLED
                job.stage = "Cancelled"
                job.add_log(str(exc), "warn")
            except Exception as exc:  # noqa: BLE001 - surfaced to the client
                job.status = FAILED
                job.error = f"{type(exc).__name__}: {exc}"
                job.stage = "Failed"
                job.add_log(job.error, "error")
                job.add_log(traceback.format_exc().strip(), "error")
            finally:
                job.finished_at = time.time()
                job._touch()
                job._done.set()
                self._finalize(job)

        threading.Thread(target=_run, name=f"coppify-{job_type}-{job.id}", daemon=True).start()
        return job


# Process-wide singleton shared by the routes.
job_store = JobStore()