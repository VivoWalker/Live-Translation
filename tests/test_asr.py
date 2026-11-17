"""Backend selection, model contracts and streaming preview regressions."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np

from server.asr import (SAMPLE_RATE, WhisperRecognizer, create_recognizer,
                        resolve_model_dir, resolve_whisper_model)
from server.streaming import StreamSession
from server.translate import MockTranslator, TranslationPipeline


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)

    def model(self, prefix="base"):
        for suffix in ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"):
            (self.directory / f"{prefix}-{suffix}").touch()

    def test_whisper_uses_matching_int8_files_and_japanese_transcription(self):
        self.model()
        with patch("server.asr.sherpa_onnx.OfflineRecognizer.from_whisper") as factory:
            rec = WhisperRecognizer(str(self.directory), num_threads=2)
        factory.assert_called_once_with(
            encoder=str(self.directory / "base-encoder.int8.onnx"),
            decoder=str(self.directory / "base-decoder.int8.onnx"),
            tokens=str(self.directory / "base-tokens.txt"),
            language="ja", task="transcribe", num_threads=2, provider="cpu", debug=False)
        self.assertEqual(rec.name, "whisper-base-int8")
        self.assertEqual(rec.partial_interval, 2)
        self.assertEqual(rec.min_partial_speech, 2)

    def test_auto_language_maps_to_sherpa_empty_language(self):
        self.model()
        with patch("server.asr.sherpa_onnx.OfflineRecognizer.from_whisper") as factory:
            WhisperRecognizer(str(self.directory), language="auto")
        self.assertEqual(factory.call_args.kwargs["language"], "")

    def test_missing_decoder_or_tokens_fails_before_native_loading(self):
        for missing in ("decoder.int8.onnx", "tokens.txt"):
            with self.subTest(missing=missing):
                self.model()
                (self.directory / f"base-{missing}").unlink()
                with self.assertRaisesRegex(FileNotFoundError, "matching"):
                    resolve_whisper_model(str(self.directory))

    def test_english_only_and_ambiguous_models_rejected(self):
        self.model("base.en")
        with self.assertRaisesRegex(ValueError, "English-only"):
            resolve_whisper_model(str(self.directory))
        self.model()
        with self.assertRaisesRegex(ValueError, "Multiple Whisper"):
            resolve_whisper_model(str(self.directory))

    def test_explicit_path_does_not_fall_back_to_environment(self):
        self.model()
        with patch.dict(os.environ, {"JLSUBS_WHISPER_MODEL_DIR": str(self.directory)}):
            self.assertEqual(resolve_whisper_model(), (self.directory, "base"))
            with self.assertRaises(FileNotFoundError):
                resolve_whisper_model(str(self.directory / "missing"))

    def test_sensevoice_requires_tokens_as_well_as_weights(self):
        (self.directory / "model.int8.onnx").touch()
        with self.assertRaisesRegex(FileNotFoundError, "tokens.txt"):
            resolve_model_dir(str(self.directory))

    def test_factory_keeps_sensevoice_default_and_selects_whisper(self):
        for engine, constructor in (("sensevoice", "SenseVoiceRecognizer"), ("whisper", "WhisperRecognizer")):
            with self.subTest(engine=engine), patch(f"server.asr.{constructor}") as factory:
                result = create_recognizer(**({} if engine == "sensevoice" else {"engine": engine}))
                self.assertIs(result, factory.return_value)
                factory.assert_called_once_with(model_dir=None, language="ja", num_threads=4)
        with self.assertRaisesRegex(ValueError, "Unknown ASR"):
            create_recognizer("unknown")
        with self.assertRaisesRegex(ValueError, "at least 1"):
            create_recognizer(num_threads=0)

    def test_native_decode_receives_mono_float32_and_skips_short_clips(self):
        self.model()
        native = MagicMock()
        native.create_stream.return_value.result.text = "  こんにちは。  "
        with patch("server.asr.sherpa_onnx.OfflineRecognizer.from_whisper", return_value=native):
            rec = WhisperRecognizer(str(self.directory))
        self.assertEqual(rec.transcribe(np.zeros(100)), "")
        native.create_stream.assert_not_called()
        self.assertEqual(rec.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float64)), "こんにちは。")
        rate, audio = native.create_stream.return_value.accept_waveform.call_args.args
        self.assertEqual(rate, SAMPLE_RATE)
        self.assertEqual(audio.dtype, np.float32)
        self.assertTrue(audio.flags.c_contiguous)
        native.decode_stream.assert_called_once_with(native.create_stream.return_value)


class PreviewTests(unittest.IsolatedAsyncioTestCase):
    def session(self):
        asr = SimpleNamespace(name="whisper-base-int8", min_partial_speech=2.0,
                              partial_interval=2.0, transcribe=lambda _: "こんにちは。")
        with patch("server.streaming.SileroVad") as vad:
            vad.return_value.in_speech = True
            session = StreamSession(asr, TranslationPipeline(MockTranslator()), lambda _: None)
        session._speech = True
        session._emit_partial = AsyncMock()
        return session

    async def test_whisper_waits_for_enough_audio_and_does_not_redecode_idle_audio(self):
        session = self.session()
        with patch("server.streaming.time.monotonic", return_value=10):
            session._total = SAMPLE_RATE
            await session._step()
            session._emit_partial.assert_not_awaited()
            session._total = SAMPLE_RATE * 2
            await session._step()
            session._emit_partial.assert_awaited_once()
        with patch("server.streaming.time.monotonic", return_value=20):
            await session._step()
            session._emit_partial.assert_awaited_once()
            session._total += SAMPLE_RATE
            await session._step()
            self.assertEqual(session._emit_partial.await_count, 2)
        await session.close()

    async def test_slow_decode_backs_off_previews_but_final_is_not_delayed(self):
        session = self.session()
        session._total = SAMPLE_RATE * 3
        session._last_partial_at = 10
        session._last_decode_ms = 3000
        with patch("server.streaming.time.monotonic", return_value=13):
            await session._step()
        session._emit_partial.assert_not_awaited()
        session.vad.in_speech = False
        session.vad.pop_segments.return_value = [np.zeros(SAMPLE_RATE * 3, dtype=np.float32)]
        session._finalize = AsyncMock()
        await session._step()
        session._finalize.assert_awaited_once()
        await session.close()
