"""Optional offline speaker diarization for authorized local recordings."""
from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from .asr import SAMPLE_RATE, resample_to_16k

MAX_AUDIO_SECONDS = 3600


@dataclass(frozen=True)
class SpeakerTurn:
    start: float
    end: float
    speaker: str


@dataclass(frozen=True)
class Diarization:
    turns: tuple[SpeakerTurn, ...]
    exclusive_turns: tuple[SpeakerTurn, ...]


class PyannoteDiarizer:
    def __init__(self, model_dir: Path, device: str = "cpu"):
        model_dir = Path(model_dir).resolve()
        if not (model_dir / "config.yaml").is_file():
            raise ValueError("A complete local Community-1 model directory is required")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
        import torch
        from pyannote.audio import Pipeline

        self.torch = torch
        self.pipeline = Pipeline.from_pretrained(str(model_dir))
        if self.pipeline is None:
            raise RuntimeError("Community-1 could not load the local model")
        self.pipeline.to(torch.device(device))

    def infer(self, audio: np.ndarray, speakers: int | None = None) -> Diarization:
        duration = len(audio) / SAMPLE_RATE
        if audio.ndim != 1 or not 0 < duration <= MAX_AUDIO_SECONDS or not np.isfinite(audio).all():
            raise ValueError("Expected up to one hour of mono 16 kHz audio")
        if speakers is not None and not 1 <= speakers <= 20:
            raise ValueError("Speaker count must be between 1 and 20")
        waveform = self.torch.from_numpy(np.ascontiguousarray(audio[None], dtype=np.float32))
        options = {"num_speakers": speakers} if speakers else {}
        result = self.pipeline({"waveform": waveform, "sample_rate": SAMPLE_RATE}, **options)

        labels: dict[str, str] = {}

        def convert(annotation):
            turns = []
            for span, _, label in annotation.itertracks(yield_label=True):
                start, end = max(0., span.start), min(duration, span.end)
                if end <= start:
                    continue
                speaker = labels.setdefault(label, f"SPEAKER_{len(labels):02d}")
                turns.append(SpeakerTurn(round(start, 3), round(end, 3), speaker))
            return tuple(turns)

        return Diarization(convert(result.speaker_diarization), convert(result.exclusive_speaker_diarization))


def annotate(captions: list[dict], turns: tuple[SpeakerTurn, ...]) -> list[dict]:
    result = []
    for caption in captions:
        if not isinstance(caption, dict):
            raise ValueError("Invalid caption")
        start, end = caption.get("start", caption.get("t_start")), caption.get("end", caption.get("t"))
        if (type(start) not in (float, int) or type(end) not in (float, int)
                or not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= MAX_AUDIO_SECONDS)):
            raise ValueError("Invalid caption timestamps")
        active = [turn for turn in turns if turn.start < end and turn.end > start]
        merged = {}
        overlap = False
        for turn in sorted(active, key=lambda turn: turn.start):
            overlap |= any(turn.speaker != speaker and finish > max(start, turn.start)
                           for speaker, finish in merged.items())
            merged[turn.speaker] = max(merged.get(turn.speaker, start), min(end, turn.end))
        result.append({**caption, "speakers": list(merged), "overlapping_speech": overlap})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--speakers", type=int)
    parser.add_argument("--captions", type=Path, help="Local JSON array of captions with start/end times")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        import soundfile as sf

        if not 0 < sf.info(args.audio).duration <= MAX_AUDIO_SECONDS:
            raise ValueError("Use a recording of at most one hour")
        audio, sample_rate = sf.read(args.audio, dtype="float32", always_2d=True)
        audio = resample_to_16k(audio.mean(axis=1), sample_rate)
        result = PyannoteDiarizer(args.model_dir, args.device).infer(audio, args.speakers)
        report = asdict(result)
        if args.captions:
            with args.captions.open("rb") as file:
                raw = file.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("Caption file exceeds 8 MiB")
            captions = json.loads(raw)
            if not isinstance(captions, list) or len(captions) > 10000:
                raise ValueError("Expected a caption array with up to 10000 entries")
            report["captions"] = annotate(captions, result.turns)
    except ImportError:
        parser.error("Install the optional requirements/diarization.txt in a dedicated environment")
    except (OSError, RuntimeError, ValueError) as error:
        parser.error(str(error))
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        with args.output.open("x", encoding="utf-8") as file:
            file.write(output)
    else:
        print(output, end="")


if __name__ == "__main__":
    main()
