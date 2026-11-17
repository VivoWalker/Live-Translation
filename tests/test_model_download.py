"""The optional model installer verifies data before touching installed files."""
import hashlib
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import download_whisper as installer


class DownloadTests(unittest.TestCase):
    def test_download_rejects_wrong_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    installer.download("https://example.invalid/model", Path(directory) / "model", "0" * 64)

    def install_fixture(self, directory, *, corrupt=False, symlink=False):
        files = {"base-encoder.int8.onnx": b"encoder", "base-decoder.int8.onnx": b"decoder"}
        hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}

        def archive_download(url, destination, digest):
            with tarfile.open(destination, "w:bz2") as archive:
                for name, data in files.items():
                    member = tarfile.TarInfo(f"sherpa-onnx-whisper-base/{name}")
                    if symlink:
                        member.type = tarfile.SYMTYPE
                        member.linkname = "../../outside"
                        archive.addfile(member)
                    else:
                        content = b"bad" if corrupt and "decoder" in name else data
                        member.size = len(content)
                        archive.addfile(member, io.BytesIO(content))

        with patch.object(installer, "MODEL_FILES", hashes), patch.object(installer, "download", side_effect=archive_download) as download:
            installer.install_model(directory)
            installer.install_model(directory)
            download.assert_called_once()
        return files

    def test_installed_files_are_verified_and_reused_without_download(self):
        with tempfile.TemporaryDirectory() as directory:
            files = self.install_fixture(Path(directory))
            for name, data in files.items():
                self.assertEqual((Path(directory) / name).read_bytes(), data)
            self.assertFalse(list(Path(directory).glob(".whisper-*")))

    def test_bad_file_does_not_replace_any_existing_model_files(self):
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / "base-encoder.int8.onnx"
            existing.write_bytes(b"previous")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                self.install_fixture(Path(directory), corrupt=True)
            self.assertEqual(existing.read_bytes(), b"previous")
            self.assertFalse((Path(directory) / "base-decoder.int8.onnx").exists())

    def test_archive_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "regular model file"):
                self.install_fixture(Path(directory), symlink=True)
            self.assertEqual(list(Path(directory).iterdir()), [])
