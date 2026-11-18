import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import numpy as np

from server.asr import Recognition
from server.asr_agent import Action, Decision
from server.asr_domain import Correction
from server.asr_review import (ReviewStore, candidates, load_holdout, pcm_sha256, reviewed_samples, suggestions,
                               training_index)

BASELINE = "なつぞらたろうです。"
REFERENCE = "夏空太郎です。"
OTHER = "別人の話です。"
EPISODE = "例の番組"
CHANGE = Correction("なつぞらたろう", "夏空太郎", 0, 8, "https://example.test")
DECISION = Decision(Action.UNCERTAIN, BASELINE, "hypothesis_conflict", alternative=REFERENCE, candidates=(CHANGE,))


class ReviewTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / "audit.sqlite"

    def record(self, store, session, sample):
        store.record(session, 0, Recognition(BASELINE, BASELINE), DECISION, EPISODE,
                     pcm=np.full(32, sample, dtype=np.float32))
        return next(row["id"] for row in store.list() if row["session"] == session)

    def accept(self, store, item, recording, reference=REFERENCE):
        store.review(item, "accepted", reference, recording=recording, reviewer="reviewer", license="fixture")

    def test_rejection_survives_retention_backup_and_deletion(self):
        store = ReviewStore(self.path, limit=2)
        rejected = self.record(store, "old", .1)
        store.review(rejected, "rejected")
        with self.assertRaisesRegex(ValueError, "rejected item"):
            self.accept(store, rejected, "same")
        store.delete(rejected)
        for session, sample in (("first", .2), ("second", .3)):
            item = self.record(store, session, sample)
            self.assertGreater(item, rejected)
            self.accept(store, item, session)
        self.assertTrue(candidates(store.list(), store.blocked())[0]["rejected"])
        destination = self.root / "backup.sqlite"
        store.compact()
        store.backup(destination)
        clone = ReviewStore(destination)
        self.assertEqual(clone.list(), store.list())
        self.assertEqual(clone.blocked(), store.blocked())
        with self.assertRaises(FileExistsError):
            store.backup(destination)

    def test_guesses_duplicates_and_conflicting_labels_are_excluded(self):
        store = ReviewStore(self.path)
        for session, sample in (("one", .1), ("duplicate", .1), ("pending", .2)):
            item = self.record(store, session, sample)
            if session != "pending":
                self.accept(store, item, "A")
        self.assertEqual(len(reviewed_samples(store.list())), 1)
        self.assertEqual(candidates(store.list(), store.blocked()), [])
        self.accept(store, self.record(store, "conflict", .1), "A", OTHER)
        self.assertEqual(reviewed_samples(store.list()), [])

    def test_recurring_hypotheses_are_visible_only_as_unverified_suggestions(self):
        store = ReviewStore(self.path)
        for i, value in enumerate((.1, .1, .2)):
            self.record(store, str(i), value)
        found = suggestions(store.list())
        self.assertTrue(found)
        self.assertTrue(all(row["distinct_samples"] == 2 and not row["verified"] for row in found))
        self.assertEqual(candidates(store.list(), store.blocked()), [])

    def test_holdout_rejects_audio_recording_and_text_leakage(self):
        store = ReviewStore(self.path)
        self.accept(store, self.record(store, "training", .1), "A")
        path = self.root / "holdout.jsonl"
        row = {"id": "independent", "episode": EPISODE, "baseline": "はい、" + BASELINE,
               "reference": "はい、" + REFERENCE, "recording": "B", "reviewer": "reviewer",
               "source": "fixture", "license": "fixture", "verified": True,
               "pcm_sha256": pcm_sha256(np.ones(32))}
        path.write_text(json.dumps(row))
        self.assertEqual(load_holdout(path, store.list()), [row])
        for change in ({"recording": "A"}, {"pcm_sha256": store.list()[0]["pcm_sha256"]},
                       {"baseline": BASELINE, "reference": REFERENCE}):
            path.write_text(json.dumps({**row, **change}))
            with self.assertRaisesRegex(ValueError, "Duplicate or review-derived"):
                load_holdout(path, store.list())
        path.write_text(json.dumps(row) + "\n" + json.dumps({**row, "id": "second"}))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            load_holdout(path, store.list())

    def test_legacy_schema_migrates_without_certifying_human_label_provenance(self):
        with sqlite3.connect(self.path) as db:
            db.execute("""CREATE TABLE review(id INTEGER PRIMARY KEY, session TEXT, segment INTEGER,
                          trace TEXT, status TEXT DEFAULT 'pending', reference TEXT DEFAULT '',
                          UNIQUE(session,segment))""")
            db.execute("INSERT INTO review VALUES (42, 'session', 0, '{}', 'accepted', 'label')")
        store = ReviewStore(self.path)
        row = store.list()[0]
        self.assertEqual((row["id"], row["reference"], row["pcm_sha256"]), (42, "label", ""))
        self.assertEqual(reviewed_samples(store.list()), [])
        self.assertGreater(self.record(store, "new", .1), 42)

    def test_training_and_validation_groups_are_disjoint(self):
        store = ReviewStore(self.path)
        for i, group in enumerate(("A", "A", "B", "C")):
            self.accept(store, self.record(store, str(i), .1 * (i + 1)), group)
        index = training_index(store.list())
        train = {row["recording"] for row in index["entries"] if row["split"] == "train"}
        validation = {row["recording"] for row in index["entries"] if row["split"] == "validation"}
        self.assertTrue(train and validation)
        self.assertFalse(train & validation)
        self.assertTrue(all(row["reference"] == REFERENCE for row in index["entries"]))
