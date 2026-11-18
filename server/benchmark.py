"""Local benchmark input validation and reproducible scoring."""
from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .diarization import SpeakerTurn
from .text import edit_distance

MAX_CLIP_SECONDS = 180
MAX_ITEMS = 1000


@dataclass(frozen=True)
class Clip:
    id: str
    audio: Path
    source: str
    license: str
    reference: str | None
    translations: dict[str, str]
    entities: tuple[str, ...] | None
    speakers: tuple[SpeakerTurn, ...]
    tags: tuple[str, ...]
    title: str


@dataclass(frozen=True)
class Dataset:
    name: str
    digest: str
    clips: tuple[Clip, ...]
    entity_catalog: tuple[str, ...]


def _bounded(value, size=1024):
    return isinstance(value, str) and 0 < len(value.strip()) <= size and len(value) <= size


def _strings(values, size=64):
    return isinstance(values, list) and len(values) <= size and all(_bounded(value, 80) for value in values)


def load_json(path: Path, maximum: int = 8 * 1024 * 1024):
    with path.open("rb") as file:
        raw = file.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("Benchmark input is too large")
    return json.loads(raw)


def _speaker_turns(data):
    if not isinstance(data, list) or len(data) > 1024:
        raise ValueError("Invalid speaker annotations")
    result = []
    for entry in data:
        if not isinstance(entry, dict):
            raise ValueError("Invalid speaker annotation")
        start, end, speaker = entry.get("start"), entry.get("end"), entry.get("speaker")
        if (type(start) not in (int, float) or type(end) not in (int, float)
                or not 0 <= start < end <= MAX_CLIP_SECONDS or not _bounded(speaker, 40)):
            raise ValueError("Invalid speaker annotation")
        result.append(SpeakerTurn(start, end, speaker))
    return tuple(result)


def load_dataset(path: Path) -> Dataset:
    import soundfile as sf

    data = load_json(path)
    if not isinstance(data, dict) or data.get("version") != 1 or not _bounded(data.get("name"), 120):
        raise ValueError("Invalid benchmark manifest")
    items, catalog = data.get("clips"), data.get("entity_catalog", [])
    if not isinstance(items, list) or not 0 < len(items) <= MAX_ITEMS or not _strings(catalog, 500):
        raise ValueError("Invalid clips or entity catalog")
    digest = hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode())
    root = path.resolve().parent
    seen, clips = set(), []
    for row in items:
        if not isinstance(row, dict):
            raise ValueError("Invalid benchmark clip")
        clip_id, name = row.get("id"), row.get("audio")
        if not _bounded(clip_id, 100) or clip_id in seen or not _bounded(name, 400) or Path(name).is_absolute():
            raise ValueError("Clip IDs must be unique and paths must be relative to the manifest")
        seen.add(clip_id)
        audio = (root / name).resolve()
        if not audio.is_relative_to(root) or not audio.is_file() or audio.stat().st_size > 128 * 1024 * 1024:
            raise ValueError(f"Invalid local audio for clip {clip_id}")
        if not 0 < sf.info(audio).duration <= MAX_CLIP_SECONDS:
            raise ValueError(f"Invalid duration for clip {clip_id}")
        with audio.open("rb") as file:
            digest.update(hashlib.file_digest(file, "sha256").digest())

        source, license_name = row.get("source"), row.get("license")
        if not _bounded(source) or not _bounded(license_name):
            raise ValueError(f"Missing provenance for clip {clip_id}")
        reference, translations = row.get("reference"), row.get("translations", {})
        entities, speakers = row.get("entities"), _speaker_turns(row.get("speakers", []))
        if ((reference is not None and not _bounded(reference, 8192)) or not isinstance(translations, dict)
                or any(target not in ("zh", "en") or not _bounded(text, 8192) for target, text in translations.items())
                or entities is not None and (not _strings(entities) or any(term not in catalog for term in entities))
                or ((reference is not None or translations or entities is not None or speakers)
                    and row.get("verified") is not True)):
            raise ValueError(f"Missing verification or invalid labels for clip {clip_id}")
        tags, title = row.get("tags", []), row.get("title", "")
        if not _strings(tags, 16) or not isinstance(title, str) or len(title) > 240:
            raise ValueError(f"Invalid metadata for clip {clip_id}")
        clips.append(Clip(clip_id, audio, source, license_name, reference, translations,
                          tuple(entities) if entities is not None else None, speakers, tuple(tags), title))
    return Dataset(data["name"], digest.hexdigest(), tuple(clips), tuple(catalog))


def normalize_for_cer(text):
    return "".join(unicodedata.normalize("NFKC", text).split())


def rate(numerator, denominator):
    return numerator / denominator if denominator else None


def latency_summary(samples):
    ordered = sorted(samples)
    if not ordered:
        return {"count": 0, "p50_ms": None, "p95_ms": None}
    return {"count": len(ordered), **{f"p{p}_ms": round(ordered[math.ceil(len(ordered) * p / 100) - 1], 1)
                                    for p in (50, 95)}}


def score_asr(dataset, predictions, *, tokenize=None):
    raw_edits = raw_length = norm_edits = norm_length = word_edits = word_length = labeled = 0
    tp = fp = fn = entity_labeled = 0
    terms = sorted(set(dataset.entity_catalog), key=lambda term: (-len(term), term))
    matcher = re.compile("|".join(re.escape(term) for term in terms)) if terms else None
    for clip in dataset.clips:
        text = predictions.get(clip.id, "")
        if clip.reference is not None:
            labeled += 1
            raw_edits += edit_distance(text, clip.reference)
            raw_length += len(clip.reference)
            normal_text, normal_reference = normalize_for_cer(text), normalize_for_cer(clip.reference)
            norm_edits += edit_distance(normal_text, normal_reference)
            norm_length += len(normal_reference)
            if tokenize is not None:
                words, reference = tokenize(normal_text), tokenize(normal_reference)
                word_edits += edit_distance(words, reference)
                word_length += len(reference)
        if clip.entities is not None:
            entity_labeled += 1
            expected = Counter(clip.entities)
            actual = Counter(matcher.findall(text)) if matcher else Counter()
            tp += sum((expected & actual).values())
            fp += sum((actual - expected).values())
            fn += sum((expected - actual).values())
    return {"labeled_clips": labeled, "reference_characters": raw_length, "cer_raw": rate(raw_edits, raw_length),
            "cer_nfkc_no_spaces": rate(norm_edits, norm_length), "wer": rate(word_edits, word_length),
            "entity_labeled_clips": entity_labeled, "entity_precision": rate(tp, tp + fp),
            "entity_recall": rate(tp, tp + fn), "entity_f1": rate(2 * tp, 2 * tp + fp + fn)}


def score_translation(dataset, predictions, target):
    pairs = [(predictions.get(clip.id, ""), clip.translations[target])
             for clip in dataset.clips if target in clip.translations]
    if not pairs:
        return {"labeled_clips": 0, "chrf": None, "missing": None}
    from sacrebleu.metrics import CHRF

    actual, references = zip(*pairs)
    return {"labeled_clips": len(pairs), "chrf": CHRF().corpus_score(list(actual), [list(references)]).score,
            "missing": sum(not text for text in actual) / len(pairs)}


def score_diarization(dataset, predictions):
    if not any(clip.speakers for clip in dataset.clips):
        return {"labeled_clips": 0, "reference_speaker_seconds": 0, "der": None}
    import soundfile as sf
    from pyannote.core import Annotation, Segment, Timeline
    from pyannote.metrics.diarization import DiarizationErrorRate

    def annotation(turns):
        result = Annotation()
        for track, turn in enumerate(turns):
            result[Segment(turn.start, turn.end), track] = turn.speaker
        return result

    metric = DiarizationErrorRate(collar=0, skip_overlap=False)
    duration = 0
    labeled = 0
    for clip in dataset.clips:
        if clip.speakers:
            labeled += 1
            duration += sum(turn.end - turn.start for turn in clip.speakers)
            metric(annotation(clip.speakers), annotation(_speaker_turns(predictions.get(clip.id, []))),
                   uem=Timeline([Segment(0, sf.info(clip.audio).duration)]))
    return {"labeled_clips": labeled, "reference_speaker_seconds": duration, "der": abs(metric) if labeled else None}
