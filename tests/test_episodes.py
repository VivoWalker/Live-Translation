import json
import tempfile
import unittest
from pathlib import Path

from server.episodes import EpisodeCatalog


class EpisodeTests(unittest.TestCase):
    def test_selects_specific_program_and_ignores_unmatched_title(self):
        catalog = EpisodeCatalog()
        active = catalog.resolve("auto", title="【学マス】初星学園ＨＲ #10")
        self.assertEqual((active.episode, active.packs), ("初星学園HR", ("gakumas",)))
        self.assertEqual(active.prompt_terms, ("藤田ことね",))
        self.assertEqual(active.corrector.correct("日高真白と藤田琴音"), "日高真白と藤田ことね")
        unknown = catalog.resolve("auto", title="雑談ラジオ")
        self.assertEqual(unknown.packs, ())
        self.assertEqual(unknown.corrector.correct("日高真白"), "日高真白")

    def test_local_catalog_applies_only_verified_aliases_and_records_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "episodes.json"
            path.write_text(json.dumps({"version": 1, "episodes": [{
                "episode": "例の番組", "franchise": "例の企画", "pack": "gakumas",
                "source": "https://example.test/show", "title_contains": ["例の番組"],
                "terms": [
                    {"canonical": "夏空太郎", "reading": "なつぞらたろう", "aliases": ["なつぞら太郎"],
                     "verified": True, "source": "https://example.test/cast"},
                    {"canonical": "秋空あき", "aliases": ["あきぞらあき"], "verified": False},
                ],
            }]}), encoding="utf-8")
            catalog = EpisodeCatalog(path)
        selection = catalog.resolve("auto", title="例の番組")
        raw = "夏空太郎、なつぞら太郎、あきぞらあき"
        text, changes = selection.corrector.explain(raw)
        self.assertEqual(text, "夏空太郎、夏空太郎、あきぞらあき")
        self.assertEqual(len(changes), 1)
        change = changes[0]
        self.assertEqual(raw[change.start:change.end], change.alias)
        self.assertEqual(change.source, "https://example.test/cast")
        self.assertEqual(selection.prompt_terms, ("夏空太郎",))
        self.assertEqual(catalog.resolve("off").corrector.correct(raw), raw)
        self.assertEqual(catalog.resolve("manual", packs=["mashiro"]).corrector.correct("日高真白"), "陽高真白")
