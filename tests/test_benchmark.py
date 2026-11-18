import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from server.benchmark import CONDITIONS, latency_summary, load_dataset, score_asr, score_corrections
from tools.benchmark import compare_reports


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

    def test_v2_verifies_file_hash_annotations_and_duplicate_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.fixture(root, reference="台詞", verified=True)
            data = json.loads(manifest.read_text())
            data.update(version=2, dataset_version="fixture-2")
            clip = data["clips"][0]
            clip.update(data_kind="synthetic", language="ja", usage_scope="test", recording="fixture",
                        conditions=dict.fromkeys(CONDITIONS, False),
                        audio_sha256=hashlib.sha256((root / "audio.wav").read_bytes()).hexdigest())
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "v2 provenance"):
                load_dataset(manifest)
            clip["annotation_source"] = "checked fixture"
            manifest.write_text(json.dumps(data))
            dataset = load_dataset(manifest)
            self.assertEqual(dataset.provenance(), {"dataset_version": "fixture-2",
                                                  "data_kinds": {"synthetic": 1}, "verified_transcripts": 1})
            data["clips"].append({**clip, "id": "duplicate"})
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "Duplicate audio"):
                load_dataset(manifest)
            data["clips"].pop()
            sf.write(root / "audio.wav", np.ones(16000), 16000)
            with self.assertRaisesRegex(ValueError, "Audio SHA-256 mismatch"):
                load_dataset(manifest)

    def test_correction_report_uses_only_independent_reference_denominators(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(Path(directory), reference="藤田ことね", verified=True, entities=["藤田ことね"])
            dataset = load_dataset(path)
            better = score_corrections(dataset, {"clip": "藤田琴音"}, {"clip": "藤田ことね"})
            worse = score_corrections(dataset, {"clip": "藤田ことね"}, {"clip": "藤田琴音"})
            self.assertEqual((better["false_correction_rate"], better["after"]["entity_f1"]), (0, 1))
            self.assertEqual(worse["false_correction_rate"], 1)
            self.assertGreater(better["net_cer_improvement"], 0)
            self.assertLess(worse["net_cer_improvement"], 0)

    def test_compare_rejects_different_manifests_speed_and_missing_text(self):
        with tempfile.TemporaryDirectory() as directory:
            dataset = load_dataset(self.fixture(Path(directory)))
            base = {"dataset_sha256": dataset.digest, "mode": "stream", "target": "zh", "audio_speed": 1,
                    "complete_sessions": 1, "clips": [{"id": "clip", "transcript": "台詞"}]}
            result = compare_reports(dataset, base, base)
            self.assertIsNone(result["net_cer_improvement"])
            for change in ({"dataset_sha256": "different"}, {"audio_speed": 2}, {"clips": [{"id": "clip"}]}):
                with self.assertRaises(ValueError):
                    compare_reports(dataset, base, {**base, **change})
