"""Inspect local decisions and evaluate reviewed spelling rules on held-out text."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.asr_review import STATUS, ReviewStore, candidates, compare_contexts, load_holdout, validate_candidates
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
    reject = commands.add_parser("reject")
    reject.add_argument("id", type=int)
    commands.add_parser("candidates")
    gate = commands.add_parser("validate")
    gate.add_argument("holdout", type=Path)
    gate.add_argument("--episode-catalog", type=Path)
    commands.add_parser("export")
    args = parser.parse_args()
    if not args.database.is_file():
        parser.error("Review database does not exist")

    store = ReviewStore(args.database)
    try:
        if args.command == "list":
            output = store.list(args.status)
        elif args.command in ("accept", "reject"):
            store.review(args.id, "accepted" if args.command == "accept" else "rejected", getattr(args, "reference", ""))
            output = {"id": args.id, "decision": args.command}
        elif args.command == "export":
            for row in store.list("accepted"):
                print(json.dumps({"id": f"{row['session']}:{row['segment']}", "reference": row["reference"],
                                  "episode": row["trace"]["episode"], "verified": True}, ensure_ascii=False))
            return
        else:
            reviews = store.list()
            proposals = candidates(reviews)
            output = proposals
            if args.command == "validate":
                holdout = load_holdout(args.holdout, reviews)
                output = {"context_strategies": compare_contexts(holdout, EpisodeCatalog(args.episode_catalog)),
                          "rules": validate_candidates(proposals, holdout)}
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
