"""Shared domain vocabulary, conservative guards and native ASR integration."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

from server.asr import SAMPLE_RATE, SenseVoiceRecognizer, WhisperRecognizer
from server.asr_domain import BUILTIN, PACKS, DomainCorrector

CASES = json.loads((Path(__file__).parent / 'fixtures/asr_domain_cases.json').read_text())


class DomainTests(unittest.TestCase):
    def test_corrects_target_vocabulary_and_preserves_ordinary_japanese(self):
        corrector = DomainCorrector()
        for raw, expected in CASES:
            with self.subTest(raw=raw):
                self.assertEqual(corrector.correct(raw), expected)
                self.assertEqual(corrector.correct(expected), expected)

    def test_independent_packs_and_legacy_selections_work(self):
        off, anime = DomainCorrector([]), DomainCorrector('anime')
        for raw, _ in CASES:
            self.assertEqual(off.correct(raw), raw)
        self.assertEqual(anime.correct('秦谷みすずの曲キャンパスモード'), '秦谷みすずの曲キャンパスモード')
        self.assertEqual(anime.correct('日高真白さんと羊宮ひなさん'), '陽高真白さんと羊宮妃那さん')
        sample = '日高真白と十王せな、秦谷みすず、羊宮ひな、逢田りかこ、みなせいのり'
        for packs, expected in [
            (['mashiro'], '陽高真白と十王星南、秦谷みすず、羊宮ひな、逢田りかこ、みなせいのり'),
            (['gakumas'], '日高真白と十王星南、秦谷美鈴、羊宮ひな、逢田りかこ、みなせいのり'),
            (['lovelive', 'bandori'], '日高真白と十王せな、秦谷みすず、羊宮妃那、逢田梨香子、みなせいのり'),
            (['general'], '日高真白と十王せな、秦谷みすず、羊宮ひな、逢田りかこ、水瀬いのり'),
        ]:
            self.assertEqual(DomainCorrector(packs).correct(sample), expected)
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            DomainCorrector(['unknown'])

    def test_all_aliases_have_unambiguous_canonical_output(self):
        for pack in PACKS:
            data = json.loads((BUILTIN / f'{pack}.json').read_text())
            corrector = DomainCorrector([pack])
            for entry in data['entries']:
                for alias in entry['aliases']:
                    cue = data['cues'][entry['requires'][0]][0] + '、' if entry.get('requires') else ''
                    with self.subTest(pack=pack, alias=alias):
                        self.assertEqual(corrector.correct(cue + alias), cue + entry['term'])

    def test_custom_file_validates_size_schema_and_alias_conflicts(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'terms.json'
            path.write_bytes(b' ' * (256 * 1024 + 1))
            with self.assertRaisesRegex(ValueError, 'too large'): DomainCorrector(path=path)
            data = json.loads((BUILTIN / 'mashiro.json').read_text())
            for bad in [None, {**data, 'version': 2}, {**data, 'entries': [data['entries'][0]] * 501},
                        {'version': 1, 'cues': {}, 'entries': [{'term': '名前', 'scope': 'common', 'aliases': ['短']}]},
                        {**data, 'entries': [data['entries'][0], data['entries'][0]]}]:
                path.write_text(json.dumps(bad))
                with self.assertRaises(ValueError): DomainCorrector(path=path)
            path.write_text(json.dumps({'version': 1, 'cues': {}, 'entries': [
                {'term': '正式名', 'scope': 'common', 'aliases': ['ABC', 'ABC DEF']},
                {'term': '別名表記', 'scope': 'common', 'aliases': ['正式']},
                {'term': '正しい名前', 'scope': 'common', 'aliases': ['(a+)+$']},
            ]}))
            corrector = DomainCorrector(path=path)
            self.assertEqual(corrector.correct('ABC DEF、ABCD、ABCです。正式名'), '正式名、ABCD、正式名です。正式名')
            self.assertEqual(corrector.correct('a' * 8000), 'a' * 8000)
            self.assertEqual(corrector.correct('(a+)+$'), '正しい名前')

    def test_correction_has_no_previous_sentence_state_and_bounds_input(self):
        corrector = DomainCorrector()
        corrector.correct('ラブライブのライブ')
        self.assertEqual(corrector.correct('アクアを買う'), 'アクアを買う')
        huge = '日高真白' * 3000
        self.assertEqual(corrector.correct(huge), huge)
        before = len(corrector.rules)
        for _ in range(2000):
            self.assertEqual(corrector.correct('日高真白さん'), '陽高真白さん')
        self.assertEqual(len(corrector.rules), before)

    def test_both_native_backends_correct_normalized_text_before_subtitle_translation(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for name in ['model.int8.onnx', 'tokens.txt', 'base-encoder.int8.onnx', 'base-decoder.int8.onnx', 'base-tokens.txt']:
                (directory / name).touch()
            for backend, factory in [(SenseVoiceRecognizer, 'from_sense_voice'), (WhisperRecognizer, 'from_whisper')]:
                native = MagicMock()
                native.create_stream.return_value.result.text = '日高 真白さんと秦谷みすず'
                with patch('server.asr.sherpa_onnx.OfflineRecognizer.' + factory, return_value=native):
                    rec = backend(tmp)
                    self.assertEqual(rec.transcribe(np.zeros(SAMPLE_RATE)), '陽高真白さんと秦谷美鈴')
                    disabled = backend(tmp, asr_domain='off')
                    self.assertEqual(disabled.transcribe(np.zeros(SAMPLE_RATE)), '日高真白さんと秦谷みすず')
                    other_language = backend(tmp, language='en')
                    self.assertEqual(other_language.transcribe(np.zeros(SAMPLE_RATE)), '日高 真白さんと秦谷みすず')
