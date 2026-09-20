"""GitHub tarball fetch + safe extract. Nothing in the repo is executed."""

from __future__ import annotations

import io
import os
import tarfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from surveyor.redact import redact_text

MAX_BYTES = 200 * 1024 * 1024
MAX_FILES = 50_000
MAX_FILE_BYTES = 8 * 1024 * 1024
USER_AGENT = "severance-surveyor/0.1"


class RepoFetchError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def to_dict(self) -> dict[str, str]:
        return {"error": self.code, "message": redact_text(self.message)}


@dataclass
class TreeHandle:
    root: Path
    bytes_total: int
    file_count: int
    ref: str
    commit: str | None = None


def _is_unsafe_name(name: str) -> bool:
    if name.startswith("/") or name.startswith("\\"):
        return True
    parts = Path(name).parts
    return any(p == ".." or p.startswith("/") for p in parts)


def safe_extract(archive: tarfile.TarFile, dest: Path, *, max_bytes: int = MAX_BYTES, max_files: int = MAX_FILES) -> TreeHandle:
    dest.mkdir(parents=True, exist_ok=True)
    members = archive.getmembers()
    # GitHub tarballs wrap a single top-level directory.
    prefixes = {m.name.split("/")[0] for m in members if m.name and not m.name.startswith("/")}
    strip = next(iter(prefixes)) if len(prefixes) == 1 else ""
    total = 0
    files = 0
    for member in members:
        if member.issym() or member.islnk():
            raise RepoFetchError("UNSAFE_ARCHIVE", "symlinks and hardlinks are refused")
        name = member.name
        if strip and (name == strip or name.startswith(strip + "/")):
            name = name[len(strip) :].lstrip("/")
        if not name:
            continue
        if _is_unsafe_name(member.name) or _is_unsafe_name(name):
            raise RepoFetchError("UNSAFE_ARCHIVE", "absolute paths and .. segments are refused")
        if member.isfile():
            files += 1
            if files > max_files:
                raise RepoFetchError("REPO_TOO_LARGE", f"file count exceeded {max_files}")
            size = member.size or 0
            total += size
            if total > max_bytes:
                raise RepoFetchError("REPO_TOO_LARGE", f"archive exceeded {max_bytes} bytes")
            if size > MAX_FILE_BYTES:
                continue
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            src = archive.extractfile(member)
            if src is None:
                continue
            data = src.read()
            target.write_bytes(data)
        elif member.isdir():
            target = dest / name
            target.mkdir(parents=True, exist_ok=True)
    return TreeHandle(root=dest, bytes_total=total, file_count=files, ref="")


def fetch_repo(
    repo_url: str,
    ref: str | None = None,
    *,
    dest: Path,
    token: str | None = None,
    client: httpx.Client | None = None,
    timeout: float = 60.0,
) -> TreeHandle:
    # https://github.com/org/repo
    parts = repo_url.rstrip("/").split("/")
    owner, name = parts[-2], parts[-1]
    if name.endswith(".git"):
        name = name[:-4]
    ref = ref or "HEAD"
    url = f"https://api.github.com/repos/{owner}/{name}/tarball/{ref}"
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.github+json",
    }
    tok = token if token is not None else os.environ.get("GITHUB_TOKEN")
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    own = client is None
    http = client or httpx.Client(timeout=timeout, follow_redirects=True)
    try:
        resp = http.get(url, headers=headers)
        if resp.status_code == 404:
            raise RepoFetchError("REPO_NOT_FOUND", f"GitHub tarball 404 for {owner}/{name}")
        if resp.status_code >= 400:
            raise RepoFetchError("REPO_FETCH_FAILED", f"GitHub tarball HTTP {resp.status_code}")
        data = resp.content
        if len(data) > MAX_BYTES:
            raise RepoFetchError("REPO_TOO_LARGE", f"tarball exceeded {MAX_BYTES} bytes")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tar:
            handle = safe_extract(tar, dest)
        handle.ref = ref
        return handle
    finally:
        if own:
            http.close()
