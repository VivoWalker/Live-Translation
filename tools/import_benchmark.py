"""Write a benchmark manifest for local clips and already checked sidecar text."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--license", required=True)
    parser.add_argument("--labels", type=Path, help="Checked ID:transcript or TSV file")
    parser.add_argument("--tag", action="append", default=[])
    args = parser.parse_args()
    labels = {}
    if args.labels:
        for line in args.labels.read_text(encoding="utf-8-sig").splitlines():
            if line.strip():
                fields = line.split("\t", 1) if "\t" in line else line.split(":", 1)
                if len(fields) != 2 or fields[0].strip() in labels:
                    parser.error("Expected unique checked ID:transcript or TSV labels")
                labels[fields[0].strip()] = fields[1].strip()
    root = args.output.resolve().parent
    clips = []
    try:
        for path in sorted(args.directory.iterdir()):
            if path.suffix.lower() not in (".wav", ".flac", ".mp3", ".ogg"):
                continue
            relative = path.resolve().relative_to(root)
            clip = {"id": path.stem, "audio": relative.as_posix(), "source": args.source,
                    "license": args.license, "tags": args.tag}
            if path.stem in labels:
                clip.update(reference=labels[path.stem], verified=True)
            clips.append(clip)
        if not clips:
            parser.error("No supported audio clips found")
        if args.labels and any("reference" not in clip for clip in clips):
            parser.error("A supplied labels file must cover every selected clip")
        with args.output.open("x", encoding="utf-8") as file:
            json.dump({"version": 1, "name": args.name, "clips": clips}, file, ensure_ascii=False, indent=2)
            file.write("\n")
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
