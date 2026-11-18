"""Bounded local review, independent holdout validation and release proposals."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from collections import defaultdict
from contextlib import closing
from dataclasses import asdict
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

from .asr_domain import DomainCorrector, EpisodeTerm, _string
from .benchmark import normalize_for_cer, rate
from .text import edit_distance, normalize_ja

MAX_TEXT = 1024
MAX_RECORDS = 512
MAX_REJECTIONS = 4096
STATUS = ("pending", "accepted", "rejected")
_SHA256 = re.compile(r"[a-f0-9]{64}")
_PROVENANCE = ("recording", "reviewer", "license")


def pcm_sha256(pcm):
    return hashlib.sha256(np.ascontiguousarray(pcm, dtype="<f4").tobytes()).hexdigest()


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def _valid_string(value, limit=MAX_TEXT):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def _replacement(before, after):
    edits = [edit for edit in SequenceMatcher(None, before, after, autojunk=False).get_opcodes() if edit[0] != "equal"]
    if len(edits) == 1:
        operation, a, b, c, d = edits[0]
        alias, canonical = before[a:b], after[c:d]
        if operation == "replace" and 3 <= len(alias) <= 24 and 3 <= len(canonical) <= 24:
            if _string(alias) and _string(canonical):
                return alias, canonical
    return None


def _rules(trace, reference=""):
    # The first key is logical, so changing provenance cannot bypass a rejection.
    episode = trace["episode"]
    if not episode:
        return {}
    original = normalize_ja(trace["original"])
    rules = {(episode, item["alias"], item["canonical"]): item["source"]
             for item in (*trace.get("changes", ()), *trace.get("candidates", ()))
             if item.get("verified", True) or not reference}
    difference = _replacement(original, normalize_ja(reference or trace["proposed"]))
    if difference:
        rules.setdefault((episode, *difference), "manual_reference" if reference else "unverified:secondary")
    return rules


class ReviewStore:
    def __init__(self, path: str | Path, *, limit: int = MAX_RECORDS):
        self.path = Path(path)
        self.limit = max(1, min(limit, MAX_RECORDS))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        except FileExistsError:
            pass
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("""CREATE TABLE IF NOT EXISTS review (
                id INTEGER PRIMARY KEY, session TEXT, segment INTEGER, trace TEXT,
                status TEXT DEFAULT 'pending', reference TEXT DEFAULT '',
                UNIQUE(session, segment)
            )""")
            db.execute("CREATE TABLE IF NOT EXISTS review_meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS rejected_rule (digest TEXT PRIMARY KEY)")
            db.execute("""INSERT OR IGNORE INTO review_meta(name,value)
                          SELECT 'last_id', COALESCE(MAX(id), 0) FROM review""")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(review)")}
            for column in ("pcm_sha256", *_PROVENANCE):
                if column not in columns:
                    db.execute(f"ALTER TABLE review ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
            for row in db.execute("SELECT trace FROM review WHERE status='rejected'").fetchall():
                self._block(db, _rules(json.loads(row["trace"])))

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=.05)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA secure_delete=ON")
        return db

    @staticmethod
    def _block(db, rules):
        if db.execute("SELECT 1 FROM review_meta WHERE name='rejection_limit'").fetchone():
            return
        for key in rules:
            db.execute("INSERT OR IGNORE INTO rejected_rule VALUES (?)", (_digest(key),))
        if db.execute("SELECT COUNT(*) FROM rejected_rule").fetchone()[0] > MAX_REJECTIONS:
            db.execute("INSERT OR REPLACE INTO review_meta VALUES ('rejection_limit', 1)")
            db.execute("DELETE FROM rejected_rule")  # The closed gate supersedes individual digests.

    def blocked(self):
        with closing(self._connect()) as db:
            if db.execute("SELECT 1 FROM review_meta WHERE name='rejection_limit'").fetchone():
                return None
            return {row[0] for row in db.execute("SELECT digest FROM rejected_rule")}

    def record(self, session, segment, primary, decision, episode, *, pcm=None):
        changes = tuple(dict.fromkeys((*primary.changes, *decision.changes)))
        trace = {"episode": episode, "original": primary.original[:MAX_TEXT], "baseline": primary.text[:MAX_TEXT],
                 "proposed": (decision.alternative or decision.text)[:MAX_TEXT], "displayed": decision.text[:MAX_TEXT],
                 "action": decision.action.value, "reason": decision.reason, "signals": decision.signals,
                 "changes": [asdict(change) for change in changes[:8]],
                 "candidates": [asdict(change) for change in decision.candidates[:8]]}
        digest = pcm_sha256(pcm) if pcm is not None else ""
        with closing(self._connect()) as db, db:
            db.execute("UPDATE review_meta SET value = value + 1 WHERE name='last_id'")
            db.execute("""INSERT OR IGNORE INTO review(id,session,segment,trace,pcm_sha256)
                          SELECT value,?,?,?,? FROM review_meta WHERE name='last_id'""",
                       (session, segment, json.dumps(trace, ensure_ascii=False), digest))
            db.execute("DELETE FROM review WHERE id < (SELECT id FROM review ORDER BY id DESC LIMIT 1 OFFSET ?)",
                       (self.limit - 1,))

    def list(self, status=None):
        if status is not None and status not in STATUS:
            raise ValueError("Invalid review status")
        with closing(self._connect()) as db:
            rows = db.execute("SELECT * FROM review WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?",
                              (status, status, self.limit))
            return [{**dict(row), "trace": json.loads(row["trace"])} for row in rows]

    def review(self, item_id, status, reference="", *, recording="", reviewer="", license=""):
        if status not in ("accepted", "rejected"):
            raise ValueError("Invalid review status")
        if status == "accepted" and not _valid_string(reference):
            raise ValueError("Accept requires a checked transcript of at most 1024 characters")
        metadata = (recording, reviewer, license)
        if any(metadata) and not all(_valid_string(value, 160) for value in metadata):
            raise ValueError("Supply recording, reviewer and usage rights together")
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM review WHERE id=?", (item_id,)).fetchone()
            if row is None:
                raise ValueError("Unknown review item")
            if row["status"] == "rejected" and status != "rejected":
                raise ValueError("A rejected item cannot be accepted")
            if status == "rejected":
                trace = json.loads(row["trace"])
                self._block(db, _rules(trace) | _rules(trace, row["reference"]))
                reference, metadata = "", ("", "", "")
            db.execute("UPDATE review SET status=?, reference=?, recording=?, reviewer=?, license=? WHERE id=?",
                       (status, reference.strip(), *(value.strip() for value in metadata), item_id))

    def backup(self, path):
        with closing(self._connect()) as source:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            try:
                with closing(sqlite3.connect(path)) as target:
                    source.backup(target)
            except (sqlite3.Error, OSError):
                Path(path).unlink(missing_ok=True)
                raise

    def delete(self, item_id):
        with closing(self._connect()) as db, db:
            if not db.execute("DELETE FROM review WHERE id=?", (item_id,)).rowcount:
                raise ValueError("Unknown review item")

    def compact(self):
        with closing(self._connect()) as db:
            db.execute("VACUUM")


def reviewed_samples(rows):
    """Return only traceable human labels and deduplicate the ASR input audio."""
    unique = {}
    conflicts = set()
    for row in rows:
        fingerprint = row.get("pcm_sha256", "")
        if (row["status"] != "accepted" or not _SHA256.fullmatch(fingerprint)
                or not _valid_string(row["reference"])
                or not all(_valid_string(row.get(key), 160) for key in _PROVENANCE)):
            continue
        previous = unique.setdefault(fingerprint, row)
        if (normalize_ja(previous["reference"]), previous["recording"]) != (
                normalize_ja(row["reference"]), row["recording"]):
            conflicts.add(fingerprint)
    return [row for key, row in unique.items() if key not in conflicts]


def _corrector(proposal):
    term = EpisodeTerm(proposal["canonical"], "", "reviewed", "normal", True,
                       proposal["source"], (proposal["alias"],))
    return DomainCorrector([], episode_terms=(term,))


def candidates(rows, blocked, minimum=2):
    if blocked is None:
        raise ValueError("The local rejection registry is full. Proposals are disabled.")
    counts = defaultdict(set)
    sources = defaultdict(set)
    for row in reviewed_samples(rows):
        trace = row["trace"]
        raw, reference = normalize_ja(trace["original"]), normalize_ja(row["reference"])
        before = edit_distance(raw, reference)
        for key, source in _rules(trace, reference).items():
            _, alias, canonical = key
            if raw.count(alias) != 1 or canonical not in reference:
                continue
            revised = raw.replace(alias, canonical, 1)
            if edit_distance(revised, reference) < before:
                counts[key].add(row["recording"])
                sources[key].add(source)
    proposals = []
    for key in sorted(counts, key=lambda key: (-len(counts[key]), key)):
        if len(counts[key]) < minimum:
            continue
        episode, alias, canonical = key
        proposal_id = _digest(key)
        evidence_sources = sorted(sources[key])
        proposals.append({"id": proposal_id, "episode": episode, "alias": alias, "canonical": canonical,
                          "source": evidence_sources[0], "evidence_sources": evidence_sources,
                          "reviewed_recordings": len(counts[key]), "rejected": proposal_id in blocked})
    return proposals[:64]


def validate_candidates(proposals, holdout):
    results = []
    for proposal in proposals:
        corrector = _corrector(proposal)
        gains = regressions = characters = before_total = after_total = 0
        changed_recordings = set()
        entity_totals = [[0, 0, 0], [0, 0, 0]]
        canonical = normalize_for_cer(proposal["canonical"])
        for row in holdout:
            if row["episode"] != proposal["episode"]:
                continue
            before = normalize_for_cer(row["baseline"])
            after = normalize_for_cer(corrector.correct(normalize_ja(row["baseline"])))
            reference = normalize_for_cer(row["reference"])
            characters += len(reference)
            before_edits = edit_distance(before, reference)
            after_edits = before_edits if after == before else edit_distance(after, reference)
            before_total += before_edits
            after_total += after_edits
            if before != after:
                changed_recordings.add(row["recording"])
                gains += max(0, before_edits - after_edits)
                regressions += max(0, after_edits - before_edits)
            for totals, text in zip(entity_totals, (before, after)):
                expected, actual = reference.count(canonical), text.count(canonical)
                totals[0] += min(expected, actual)
                totals[1] += max(0, actual - expected)
                totals[2] += max(0, expected - actual)
        entity_f1 = [rate(2 * tp, 2 * tp + fp + fn) for tp, fp, fn in entity_totals]
        entity_regression = entity_f1[0] is not None and (entity_f1[1] or 0) < entity_f1[0]
        if proposal["rejected"] or regressions or entity_regression:
            status = "rejected"
        elif len(changed_recordings) >= 2 and gains:
            status = "approval_required"
        else:
            status = "insufficient_evidence"
        results.append({**proposal, "holdout_affected_recordings": len(changed_recordings), "reference_characters": characters,
                        "cer_before": rate(before_total, characters), "cer_after": rate(after_total, characters),
                        "entity_f1_before": entity_f1[0], "entity_f1_after": entity_f1[1],
                        "improved_characters": gains, "regressed_characters": regressions, "status": status})
    return results


def load_holdout(path, review_rows):
    ids = {f"{row['session']}:{row['segment']}" for row in review_rows}
    hashes = {row.get("pcm_sha256", "") for row in review_rows}
    recordings = {row.get("recording", "") for row in review_rows}
    texts = {(normalize_for_cer(row["trace"]["original"]), normalize_for_cer(row["reference"]))
             for row in review_rows if row["reference"]}
    rows = []
    with Path(path).open("rb") as file:
        raw = file.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Holdout file exceeds 2 MiB")
    for line in raw.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if (not isinstance(row, dict) or row.get("verified") is not True
                or not all(_valid_string(row.get(key)) for key in ("id", "episode", "baseline", "reference", "source"))
                or not all(_valid_string(row.get(key), 160) for key in _PROVENANCE)
                or not isinstance(row.get("pcm_sha256"), str) or not _SHA256.fullmatch(row["pcm_sha256"])):
            raise ValueError("Holdout requires verified transcripts, provenance and a PCM SHA-256")
        pair = (normalize_for_cer(row["baseline"]), normalize_for_cer(row["reference"]))
        if row["id"] in ids or row["pcm_sha256"] in hashes or row["recording"] in recordings or pair in texts:
            raise ValueError("Duplicate or review-derived sample in holdout")
        ids.add(row["id"])
        hashes.add(row["pcm_sha256"])
        texts.add(pair)
        rows.append(row)
    if not rows or len(rows) > 500:
        raise ValueError("Holdout requires 1–500 verified rows")
    return rows


def compare_contexts(holdout, catalog):
    manual = DomainCorrector()
    totals = dict.fromkeys(("off", "manual", "auto"), 0)
    characters = 0
    for row in holdout:
        text, reference = normalize_ja(row["baseline"]), row["reference"]
        auto = catalog.resolve("auto", title=row["episode"][:240]).corrector
        for name, output in (("off", text), ("manual", manual.correct(text)), ("auto", auto.correct(text))):
            totals[name] += edit_distance(output, reference)
        characters += len(reference)
    return {"rows": len(holdout), "reference_characters": characters, "cer": {
        name: edits / characters for name, edits in totals.items()
    }}


def training_index(rows):
    samples = reviewed_samples(rows)
    groups = sorted({row["recording"] for row in samples}, key=_digest)
    if len(groups) < 2:
        raise ValueError("Training and validation require at least two independently recorded groups")
    validation = set(groups[:max(1, len(groups) // 5)])
    return {"schema": "reviewed-asr-labels-v1", "entries": [
        {"id": f"{row['session']}:{row['segment']}", "reference": row["reference"], "pcm_sha256": row["pcm_sha256"],
         **{key: row[key] for key in _PROVENANCE}, "split": "validation" if row["recording"] in validation else "train"}
        for row in sorted(samples, key=lambda row: row["pcm_sha256"])
    ]}
