"""Opt-in bounded storage and offline review of local ASR decisions."""
from __future__ import annotations

import json
import os
import sqlite3
from collections import Counter
from contextlib import closing
from dataclasses import asdict
from difflib import SequenceMatcher
from pathlib import Path

from .asr_domain import DomainCorrector, EpisodeTerm
from .text import edit_distance

MAX_TEXT = 1024
MAX_RECORDS = 512
STATUS = ("pending", "accepted", "rejected")


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
            db.execute("""CREATE TABLE IF NOT EXISTS review (
                id INTEGER PRIMARY KEY, session TEXT, segment INTEGER, trace TEXT,
                status TEXT DEFAULT 'pending', reference TEXT DEFAULT '',
                UNIQUE(session, segment)
            )""")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=.05)
        db.row_factory = sqlite3.Row
        return db

    def record(self, session, segment, primary, decision, episode):
        changes = tuple(dict.fromkeys((*primary.changes, *decision.changes)))
        trace = {"episode": episode, "original": primary.original[:MAX_TEXT], "baseline": primary.text[:MAX_TEXT],
                 "proposed": (decision.alternative or decision.text)[:MAX_TEXT], "displayed": decision.text[:MAX_TEXT],
                 "action": decision.action.value, "reason": decision.reason, "signals": decision.signals,
                 "changes": [asdict(change) for change in changes[:8]],
                 "candidates": [asdict(change) for change in decision.candidates[:8]]}
        with closing(self._connect()) as db, db:
            db.execute("INSERT OR IGNORE INTO review(session,segment,trace) VALUES(?,?,?)",
                       (session, segment, json.dumps(trace, ensure_ascii=False)))
            db.execute("DELETE FROM review WHERE id < (SELECT id FROM review ORDER BY id DESC LIMIT 1 OFFSET ?)",
                       (self.limit - 1,))

    def list(self, status=None):
        if status is not None and status not in STATUS:
            raise ValueError("Invalid review status")
        with closing(self._connect()) as db:
            rows = db.execute("SELECT * FROM review WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?",
                              (status, status, self.limit))
            return [{**dict(row), "trace": json.loads(row["trace"])} for row in rows]

    def review(self, item_id, status, reference=""):
        if status == "accepted" and (not reference.strip() or len(reference) > MAX_TEXT):
            raise ValueError("Accept requires a checked transcript of at most 1024 characters")
        if status not in ("accepted", "rejected"):
            raise ValueError("Invalid review status")
        with closing(self._connect()) as db, db:
            updated = db.execute("UPDATE review SET status=?, reference=? WHERE id=?",
                                 (status, reference.strip() if status == "accepted" else "", item_id))
            if not updated.rowcount:
                raise ValueError("Unknown review item")


def candidates(rows, minimum=2):
    counts, accepted, rejected = Counter(), Counter(), Counter()
    for row in rows:
        trace = row["trace"]
        seen = {(trace["episode"], change["alias"], change["canonical"], change["source"]) for change in trace["changes"]}
        if trace["reason"] == "hypothesis_conflict":
            left, right = trace["baseline"], trace["proposed"]
            edits = [edit for edit in SequenceMatcher(None, left, right, autojunk=False).get_opcodes() if edit[0] != "equal"]
            if len(edits) == 1:
                tag, a, b, c, d = edits[0]
                if tag == "replace" and 3 <= b - a <= 24 and 3 <= d - c <= 24:
                    seen.add((trace["episode"], left[a:b], right[c:d], "unverified:secondary"))
        for key in seen:
            counts[key] += 1
            if row["status"] == "accepted" and key[2] in row["reference"]:
                accepted[key] += 1
            elif row["status"] == "rejected":
                rejected[key] += 1
    return [{"episode": key[0], "alias": key[1], "canonical": key[2], "source": key[3],
             "occurrences": count, "accepted": accepted[key], "rejected": rejected[key]}
            for key, count in counts.most_common() if count >= minimum]


def validate_candidates(proposals, holdout):
    results = []
    for proposal in proposals:
        if (not proposal["episode"] or proposal["accepted"] < 2 or proposal["rejected"]
                or proposal["source"].startswith("unverified:")):
            continue
        term = EpisodeTerm(proposal["canonical"], "", "reviewed", "normal", True,
                           proposal["source"], (proposal["alias"],))
        corrector = DomainCorrector([], episode_terms=(term,))
        improvements = regressions = affected = 0
        for row in holdout:
            if row["episode"] != proposal["episode"]:
                continue
            before = row["baseline"]
            after = corrector.correct(before)
            if before != after:
                affected += 1
                delta = edit_distance(before, row["reference"]) - edit_distance(after, row["reference"])
                improvements += max(0, delta)
                regressions += max(0, -delta)
        results.append({**proposal, "held_out_affected": affected, "improved_characters": improvements,
                        "regressed_characters": regressions, "promotable": improvements > 0 and regressions == 0})
    return results


def load_holdout(path, review_rows):
    seen = {f"{row['session']}:{row['segment']}" for row in review_rows}
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
                or any(not isinstance(row.get(key), str) or not row[key].strip() or len(row[key]) > MAX_TEXT
                       for key in ("id", "episode", "baseline", "reference", "source"))
                or row["id"] in seen):
            raise ValueError("Holdout requires independent verified rows with id, episode, baseline, reference and source")
        seen.add(row["id"])
        rows.append(row)
    if not rows or len(rows) > 500:
        raise ValueError("Holdout requires 1–500 verified rows")
    return rows


def compare_contexts(holdout, catalog):
    manual = DomainCorrector()
    totals = dict.fromkeys(("off", "manual", "auto"), 0)
    characters = 0
    for row in holdout:
        text, reference = row["baseline"], row["reference"]
        auto = catalog.resolve("auto", title=row["episode"][:240]).corrector
        for name, output in (("off", text), ("manual", manual.correct(text)), ("auto", auto.correct(text))):
            totals[name] += edit_distance(output, reference)
        characters += len(reference)
    return {"rows": len(holdout), "reference_characters": characters, "cer": {
        name: edits / characters for name, edits in totals.items()
    }}
