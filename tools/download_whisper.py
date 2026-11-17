"""Download the pinned multilingual Whisper base int8 model and Silero VAD.

Uses only Python's standard library. Existing files are verified before reuse;
downloads are verified before extraction or replacement. No model is fetched
automatically when the subtitle service starts.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
ARCHIVE = "sherpa-onnx-whisper-base.tar.bz2"
ARCHIVE_SHA256 = "911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de"
MODEL_FILES = {
    "base-encoder.int8.onnx": "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11",
    "base-decoder.int8.onnx": "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d",
    "base-tokens.txt": "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
}
VAD_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"


def verified(path: Path, digest: str) -> bool:
    if not path.is_file():
        return False
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest() == digest


def download(url: str, destination: Path, digest: str) -> None:
    print(f"Downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=60) as source, destination.open("wb") as target:
        shutil.copyfileobj(source, target)
    if not verified(destination, digest):
        raise ValueError(f"SHA-256 mismatch: {destination.name}")


def install_model(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    if all(verified(directory / name, digest) for name, digest in MODEL_FILES.items()):
        print(f"Whisper files verified: {directory}")
        return
    with tempfile.TemporaryDirectory(prefix=".whisper-", dir=directory) as temporary:
        staging = Path(temporary)
        archive = staging / ARCHIVE
        download(RELEASE + ARCHIVE, archive, ARCHIVE_SHA256)
        with tarfile.open(archive, "r:bz2") as bundle:
            for name, digest in MODEL_FILES.items():
                member = bundle.getmember(f"sherpa-onnx-whisper-base/{name}")
                if not member.isfile():
                    raise ValueError(f"Expected regular model file: {name}")
                with bundle.extractfile(member) as source, (staging / name).open("wb") as target:
                    shutil.copyfileobj(source, target)
                if not verified(staging / name, digest):
                    raise ValueError(f"SHA-256 mismatch: {name}")
        # All three files must verify before replacing any installed files.
        for name in MODEL_FILES:
            (staging / name).replace(directory / name)
    print(f"Whisper installed: {directory}")


def install_vad(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / "silero_vad.onnx"
    if verified(destination, VAD_SHA256):
        print(f"VAD verified: {destination}")
        return
    with tempfile.TemporaryDirectory(prefix=".vad-", dir=directory) as temporary:
        staged = Path(temporary) / destination.name
        download(RELEASE + destination.name, staged, VAD_SHA256)
        staged.replace(destination)
    print(f"VAD installed: {destination}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=ROOT / "models" / "whisper-base")
    parser.add_argument("--vad-dir", type=Path, default=ROOT / "models" / "silero")
    args = parser.parse_args()
    install_model(args.model_dir)
    install_vad(args.vad_dir)


if __name__ == "__main__":
    main()
