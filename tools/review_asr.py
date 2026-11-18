"""Inspect local decisions and evaluate reviewed spelling rules on held-out text."""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.asr_review import (STATUS, ReviewStore, candidates, compare_contexts, load_holdout,
                               reviewed_samples, suggestions, training_index, validate_candidates)
from server.episodes import EpisodeCatalog


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list")
    listing.add_argument("--status", choices=STATUS)
    accept = commands.add_parser("accept")
    accept.add_argument("id", type=int)
    accept.add_argument("--reference", required=True)
    accept.add_argument("--recording", required=True, help="Stable ID of the original recording, shared by its clips")
    accept.add_argument("--reviewer", required=True, help="Identifier of the person who checked the transcript")
    accept.add_argument("--license", required=True, help="Rights and allowed usage for the source")
    reject = commands.add_parser("reject")
    reject.add_argument("id", type=int)
    commands.add_parser("candidates")
    commands.add_parser("suggestions")
    gate = commands.add_parser("validate")
    gate.add_argument("holdout", type=Path)
    gate.add_argument("--episode-catalog", type=Path)
    gate.add_argument("--output", type=Path)
    approve = commands.add_parser("approve")
    approve.add_argument("holdout", type=Path)
    approve.add_argument("rule_id")
    approve.add_argument("--reviewer", required=True)
    approve.add_argument("--output", type=Path, required=True)
    commands.add_parser("training-index").add_argument("--output", type=Path, required=True)
    commands.add_parser("backup").add_argument("path", type=Path)
    commands.add_parser("delete").add_argument("id", type=int)
    commands.add_parser("compact")
    commands.add_parser("export")
    args = parser.parse_args()
    if not args.database.is_file():
        parser.error("Review database does not exist")

    try:
        store = ReviewStore(args.database)
        if args.command == "list":
            output = store.list(args.status)
        elif args.command in ("accept", "reject"):
            if args.command == "accept":
                store.review(args.id, "accepted", args.reference, recording=args.recording,
                             reviewer=args.reviewer, license=args.license)
            else:
                store.review(args.id, "rejected")
            output = {"id": args.id, "decision": args.command}
        elif args.command == "export":
            for row in reviewed_samples(store.list("accepted")):
                print(json.dumps({"id": f"{row['session']}:{row['segment']}", "reference": row["reference"],
                                  "episode": row["trace"]["episode"], "verified": True, "pcm_sha256": row["pcm_sha256"],
                                  "recording": row["recording"], "reviewer": row["reviewer"],
                                  "license": row["license"]}, ensure_ascii=False))
            return
        elif args.command == "training-index":
            output = training_index(store.list("accepted"))
        elif args.command == "suggestions":
            output = {"schema": "asr-unverified-suggestions-v1", "suggestions": suggestions(store.list("pending"))}
        elif args.command == "backup":
            store.backup(args.path)
            output = {"backed_up": True}
        elif args.command == "delete":
            store.delete(args.id)
            output = {"deleted": args.id}
        elif args.command == "compact":
            store.compact()
            output = {"compacted": True}
        else:
            reviews = store.list()
            proposals = candidates(reviews, store.blocked())
            output = proposals
            if args.command in ("validate", "approve"):
                holdout = load_holdout(args.holdout, reviews)
                holdout_sha256 = hashlib.sha256(json.dumps(holdout, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                rules = validate_candidates(proposals, holdout)
                if args.command == "validate":
                    output = {"schema": "asr-rule-proposals-v1", "holdout_sha256": holdout_sha256,
                              "context_strategies": compare_contexts(holdout, EpisodeCatalog(args.episode_catalog)),
                              "rules": rules}
                else:
                    rule = next((rule for rule in rules if rule["id"] == args.rule_id), None)
                    if not rule or rule["status"] != "approval_required" or not 1 <= len(args.reviewer.strip()) <= 160:
                        raise ValueError("Approval requires an eligible rule and a reviewer")
                    output = {"schema": "asr-rule-approval-v1", "reviewer": args.reviewer.strip(),
                              "holdout_sha256": holdout_sha256, "rule": rule}
        result = json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if getattr(args, "output", None):
            with args.output.open("x", encoding="utf-8") as file:
                file.write(result)
        else:
            print(result, end="")
    except (ValueError, OSError, sqlite3.Error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
