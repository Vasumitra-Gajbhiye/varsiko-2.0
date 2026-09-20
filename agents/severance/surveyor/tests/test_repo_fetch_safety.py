import io
import tarfile
from pathlib import Path

import pytest

from surveyor.repo_fetch import RepoFetchError, safe_extract


def _tar_with(members: list[tuple[str, bytes, str]]) -> tarfile.TarFile:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data, kind in members:
            info = tarfile.TarInfo(name=name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
            elif kind == "sym":
                info.type = tarfile.SYMTYPE
                info.linkname = data.decode()
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
                continue
            tar.addfile(info)
    buf.seek(0)
    return tarfile.open(fileobj=buf, mode="r")


def test_rejects_dotdot(tmp_path: Path):
    tar = _tar_with([("repo/../secret.txt", b"nope", "file")])
    with pytest.raises(RepoFetchError) as exc:
        safe_extract(tar, tmp_path / "out")
    assert exc.value.code == "UNSAFE_ARCHIVE"
    assert not (tmp_path / "secret.txt").exists()


def test_rejects_symlink(tmp_path: Path):
    tar = _tar_with([("repo/link", b"/etc/passwd", "sym")])
    with pytest.raises(RepoFetchError) as exc:
        safe_extract(tar, tmp_path / "out")
    assert exc.value.code == "UNSAFE_ARCHIVE"


def test_rejects_oversize(tmp_path: Path):
    tar = _tar_with([("repo/a.txt", b"hello world", "file")])
    with pytest.raises(RepoFetchError) as exc:
        safe_extract(tar, tmp_path / "out", max_bytes=4)
    assert exc.value.code == "REPO_TOO_LARGE"


def test_strips_github_prefix(tmp_path: Path):
    tar = _tar_with(
        [
            ("victim-app-main/", b"", "dir"),
            ("victim-app-main/app/page.tsx", b"export default function Page(){return null}", "file"),
        ]
    )
    handle = safe_extract(tar, tmp_path / "out")
    assert (handle.root / "app" / "page.tsx").is_file()
