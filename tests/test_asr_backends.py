import asyncio
import sys
import tempfile
import threading
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np

from server.asr import BackendUnavailable, RecognitionContext, create_recognizer
from server.asr_router import DecodeScheduler, select_recognizer


class BackendsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)
        self.audio = np.zeros(6400, dtype=np.float32)

    def fixtures(self, *names):
        for name in names:
            (self.path / name).touch()

    def test_parakeet_restores_local_checkpoint_and_reads_japanese_hypothesis(self):
        self.fixtures("parakeet-tdt_ctc-0.6b-ja.nemo")
        torch = SimpleNamespace(set_num_threads=MagicMock(), device=str, float32="fp32", inference_mode=nullcontext)
        model = MagicMock()
        model.transcribe.return_value = [SimpleNamespace(text="あ い")]
        api = MagicMock()
        api.restore_from.return_value = model
        with patch.dict(sys.modules, {"torch": torch, "nemo.collections.asr.models": SimpleNamespace(ASRModel=api)}):
            asr = create_recognizer("parakeet", str(self.path))
        result = asr.recognize(self.audio)
        self.assertEqual((result.original, result.text), ("あ い", "あい"))
        self.assertEqual(Path(api.restore_from.call_args.args[0]).suffix, ".nemo")
        self.assertFalse(asr.capabilities.context_prompt)
        self.assertTrue(asr.capabilities.partial_transcription)

    def test_whisper_turbo_returns_timestamps_and_uses_the_supplied_prompt(self):
        self.fixtures("config.json", "model.bin", "tokenizer.json", "vocabulary.json")
        api = MagicMock()
        api.return_value.transcribe.return_value = ([SimpleNamespace(start=0., end=.4, text="台詞")], None)
        with patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=api)}):
            asr = create_recognizer("whisper-turbo", str(self.path))
        result = asr.recognize(self.audio, RecognitionContext(terms=("藤田ことね",)))
        self.assertEqual(result.timestamps, ((0., .4, "台詞"),))
        self.assertEqual(api.return_value.transcribe.call_args.kwargs["initial_prompt"], "藤田ことね")
        self.assertTrue(api.call_args.kwargs["local_files_only"])
        self.assertFalse(asr.capabilities.partial_transcription)

    def test_qwen_loads_local_transformers_model_and_passes_japanese_audio(self):
        self.fixtures("config.json", "preprocessor_config.json", "tokenizer_config.json")
        torch = SimpleNamespace(bfloat16="bf16")
        api = MagicMock()
        api.from_pretrained.return_value.transcribe.return_value = [SimpleNamespace(text="おはよう")]
        with patch.dict(sys.modules, {"torch": torch, "qwen_asr": SimpleNamespace(Qwen3ASRModel=api)}):
            asr = create_recognizer("qwen3-asr", str(self.path), device="cuda")
        self.assertEqual(asr.transcribe(self.audio, RecognitionContext(terms=("番組",))), "おはよう")
        kwargs = api.from_pretrained.return_value.transcribe.call_args.kwargs
        self.assertEqual((kwargs["audio"][1], kwargs["language"], kwargs["context"]), (16000, "Japanese", "番組"))
        self.assertEqual(asr.capabilities.precision, "bfloat16")

    def test_load_failure_uses_cpu_fallback_and_off_is_strict(self):
        factory = MagicMock(side_effect=[BackendUnavailable("missing"), "fallback"])
        with patch("server.asr_router.create_recognizer", factory):
            self.assertEqual(select_recognizer("parakeet", device="cuda", fallback_dir="base"),
                             ("fallback", "parakeet"))
        self.assertEqual(factory.call_args.args, ("sensevoice",))
        self.assertEqual(factory.call_args.kwargs, {"model_dir": "base", "device": "cpu", "precision": "int8"})
        with patch("server.asr_router.create_recognizer", side_effect=BackendUnavailable("missing")):
            with self.assertRaises(BackendUnavailable):
                select_recognizer("parakeet", allow_fallback=False)


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_consumer_keeps_slot_until_native_work_completes(self):
        scheduler = DecodeScheduler()
        started = asyncio.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        loop = asyncio.get_running_loop()

        def native():
            loop.call_soon_threadsafe(started.set)
            release.wait(timeout=3)
            return "finished"

        active = asyncio.create_task(scheduler.run(native))
        await asyncio.wait_for(started.wait(), 3)
        active.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await active
        final = asyncio.create_task(scheduler.run(lambda: "final"))
        await asyncio.sleep(0)
        self.assertFalse(final.done())
        self.assertIsNone(await scheduler.run(lambda: "preview", optional=True))
        release.set()
        self.assertEqual(await asyncio.wait_for(final, 3), "final")
