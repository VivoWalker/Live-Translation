"""Write a benchmark manifest for local clips and already checked sidecar text."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.benchmark import CONDITIONS, DATA_KINDS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--license", required=True)
    parser.add_argument("--dataset-version", default="1")
    parser.add_argument("--usage-scope", required=True)
    parser.add_argument("--kind", choices=DATA_KINDS, required=True)
    parser.add_argument("--recording", required=True, help="Stable source recording or collection ID")
    for key in CONDITIONS:
        parser.add_argument("--" + key.replace("_", "-"), choices=("yes", "no", "unknown"), default="unknown")
    parser.add_argument("--labels", type=Path, help="Checked ID:transcript or TSV file")
    parser.add_argument("--annotation-source", help="Person or source that verified the labels")
    parser.add_argument("--tag", action="append", default=[])
    args = parser.parse_args()
    labels = {}
    if args.labels:
        if not args.annotation_source:
            parser.error("--labels requires --annotation-source")
        for line in args.labels.read_text(encoding="utf-8-sig").splitlines():
            if line.strip():
                fields = line.split("\t", 1) if "\t" in line else line.split(":", 1)
                if len(fields) != 2 or not all(field.strip() for field in fields) or fields[0].strip() in labels:
                    parser.error("Expected unique checked ID:transcript or TSV labels")
                labels[fields[0].strip()] = fields[1].strip()
    root = args.output.resolve().parent
    clips = []
    values = {"yes": True, "no": False, "unknown": None}
    conditions = {key: values[getattr(args, key)] for key in CONDITIONS}
    try:
        for path in sorted(args.directory.iterdir()):
            if path.suffix.lower() not in (".wav", ".flac", ".mp3", ".ogg"):
                continue
            relative = path.resolve().relative_to(root)
            with path.open("rb") as file:
                audio_sha256 = hashlib.file_digest(file, "sha256").hexdigest()
            clip = {"id": path.stem, "audio": relative.as_posix(), "source": args.source,
                    "license": args.license, "usage_scope": args.usage_scope, "tags": args.tag, "language": "ja",
                    "recording": args.recording, "data_kind": args.kind, "conditions": conditions, "audio_sha256": audio_sha256}
            if path.stem in labels:
                clip.update(reference=labels[path.stem], verified=True, annotation_source=args.annotation_source)
            clips.append(clip)
        if not clips:
            parser.error("No supported audio clips found")
        if args.labels and set(labels) != {clip["id"] for clip in clips}:
            parser.error("A supplied labels file must cover every selected clip")
        with args.output.open("x", encoding="utf-8") as file:
            json.dump({"version": 2, "dataset_version": args.dataset_version, "name": args.name, "clips": clips},
                      file, ensure_ascii=False, indent=2)
            file.write("\n")
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
