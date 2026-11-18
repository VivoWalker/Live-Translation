import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np

from server.diarization import PyannoteDiarizer, SpeakerTurn, annotate


class DiarizationTests(unittest.TestCase):
    def test_local_pipeline_returns_anonymous_timed_overlapping_tracks(self):
        with tempfile.TemporaryDirectory() as directory:
            model_dir = Path(directory)
            (model_dir / "config.yaml").touch()
            torch = SimpleNamespace(device=str, from_numpy=lambda value: value)
            first = (SimpleNamespace(start=0., end=.6), 0, "native-label-1")
            second = (SimpleNamespace(start=.3, end=1.1), 1, "native-label-2")
            pipeline = MagicMock()
            pipeline.return_value = SimpleNamespace(
                speaker_diarization=SimpleNamespace(itertracks=lambda **_: [first, second]),
                exclusive_speaker_diarization=SimpleNamespace(itertracks=lambda **_: [first]),
            )
            module = SimpleNamespace(Pipeline=SimpleNamespace(from_pretrained=lambda _: pipeline))
            with patch.dict("sys.modules", {"torch": torch, "pyannote.audio": module}), patch.dict("os.environ"):
                result = PyannoteDiarizer(model_dir).infer(np.zeros(16000, dtype=np.float32), 2)
            self.assertEqual(result.turns, (SpeakerTurn(0, .6, "SPEAKER_00"), SpeakerTurn(.3, 1, "SPEAKER_01")))
            self.assertEqual(pipeline.call_args.args[0]["sample_rate"], 16000)
            self.assertEqual(pipeline.call_args.kwargs, {"num_speakers": 2})
            captions = annotate([{"t_start": .4, "t": .5, "text": "はい"}], result.turns)
            self.assertEqual(captions[0]["speakers"], ["SPEAKER_00", "SPEAKER_01"])
            self.assertTrue(captions[0]["overlapping_speech"])

    def test_sequential_speakers_within_one_caption_do_not_count_as_overlap(self):
        turns = (SpeakerTurn(0, 1, "SPEAKER_00"), SpeakerTurn(1, 2, "SPEAKER_01"))
        [caption] = annotate([{"start": .5, "end": 1.5}], turns)
        self.assertFalse(caption["overlapping_speech"])
