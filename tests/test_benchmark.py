import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from server.benchmark import latency_summary, load_dataset, score_asr


class BenchmarkTests(unittest.TestCase):
    def fixture(self, root, **extra):
        sf.write(root / "audio.wav", np.zeros(16000, dtype=np.float32), 16000)
        manifest = root / "manifest.json"
        row = {"id": "clip", "audio": "audio.wav", "source": "synthetic fixture", "license": "test", **extra}
        manifest.write_text(json.dumps({"version": 1, "name": "fixture", "clips": [row],
                                        "entity_catalog": ["藤田ことね", "ことね", "花海咲季"]}), encoding="utf-8")
        return manifest

    def test_unlabeled_audio_has_unavailable_accuracy_and_a_stable_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.fixture(Path(directory))
            dataset = load_dataset(manifest)
            scores = score_asr(dataset, {"clip": "台詞"})
            self.assertIsNone(scores["cer_raw"])
            self.assertIsNone(scores["wer"])
            self.assertIsNone(scores["entity_f1"])
            self.assertEqual(dataset.digest, load_dataset(manifest).digest)
            sf.write(Path(directory) / "audio.wav", np.ones(16000, dtype=np.float32), 16000)
            self.assertNotEqual(dataset.digest, load_dataset(manifest).digest)

    def test_raw_preserves_width_and_spacing_and_entity_matching_is_longest_first(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.fixture(Path(directory), reference="Ａ 藤田ことね", entities=["藤田ことね"], verified=True)
            dataset = load_dataset(manifest)
            scores = score_asr(dataset, {"clip": "A藤田ことね"}, tokenize=list)
            self.assertGreater(scores["cer_raw"], 0)
            self.assertEqual(scores["cer_nfkc_no_spaces"], 0)
            self.assertEqual(scores["wer"], 0)
            self.assertEqual(scores["entity_f1"], 1)

    def test_reference_requires_provenance_and_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.fixture(Path(directory), reference="台詞")
            with self.assertRaisesRegex(ValueError, "verification"):
                load_dataset(manifest)
            manifest = Path(directory) / "manifest.json"
            data = json.loads(manifest.read_text())
            data["clips"][0].update(verified=True, license="")
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "provenance"):
                load_dataset(manifest)

    def test_latency_reports_unavailable_quantiles_without_observations(self):
        self.assertEqual(latency_summary([]), {"count": 0, "p50_ms": None, "p95_ms": None})
        self.assertEqual(latency_summary(range(1, 21)), {"count": 20, "p50_ms": 10., "p95_ms": 19.})
