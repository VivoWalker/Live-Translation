"""Stateless domain spelling correction, sharing the browser's bounded lexicons."""
from __future__ import annotations

import json
import re
from pathlib import Path

PROFILES = ("off", "anime", "gakumas")
PACKS = ("mashiro", "gakumas", "bandori", "lovelive", "general")
BUILTIN = Path(__file__).resolve().parent.parent / "extension" / "asr-terms"
MAX_BYTES = 256 * 1024
RADIUS = 24
SENTENCE_BREAK = re.compile(r"[。\r\n]")
KATAKANA = re.compile(r"[ァ-ヺーヽヾ]+")


def normalize_packs(selection: str | list[str]) -> tuple[str, ...]:
    if selection == "gakumas":
        return PACKS
    if selection == "off":
        return ()
    if selection == "anime":
        return tuple(pack for pack in PACKS if pack != "gakumas")
    if (not isinstance(selection, list) or len(selection) > len(PACKS)
            or not all(pack in PACKS for pack in selection)):
        raise ValueError("Unknown ASR domain")
    return tuple(pack for pack in PACKS if pack in selection)


def _string(value, minimum: int = 2) -> bool:
    return (isinstance(value, str) and minimum <= len(value) <= 80 and value == value.strip()
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def _read(path: Path, profile: str = "gakumas"):
    with path.open("rb") as source:
        raw = source.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("ASR lexicon too large")
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError("Invalid ASR lexicon JSON") from None
    if (not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1
            or not isinstance(data.get("entries"), list) or len(data["entries"]) > 500
            or not isinstance(data.get("cues"), dict) or len(data["cues"]) > 16):
        raise ValueError("Invalid ASR lexicon")
    cues = data["cues"]
    for values in cues.values():
        if not isinstance(values, list) or len(values) > 40 or not all(_string(value, 1) for value in values):
            raise ValueError("Invalid ASR lexicon cues")

    def context(requires):
        if (not isinstance(requires, list) or not 1 <= len(requires) <= 16
                or not all(isinstance(name, str) and name in cues for name in requires)):
            raise ValueError("Invalid ASR lexicon cues")
        return tuple(cue for name in requires for cue in cues[name])

    aliases, terms, rules = set(), set(), []
    for entry in data["entries"]:
        if (not isinstance(entry, dict) or not _string(entry.get("term"))
                or entry.get("scope", "common") not in ("common", "gakumas")
                or not isinstance(entry.get("aliases"), list) or len(entry["aliases"]) > 12):
            raise ValueError("Invalid ASR lexicon entry")
        entry_cues = context(entry["requires"]) if "requires" in entry else None
        term = entry["term"]
        terms.add(term)
        for value in entry["aliases"]:
            if isinstance(value, dict):
                alias = value.get("text")
                alias_cues = context(value["requires"]) if "requires" in value else entry_cues
                katakana_boundary = value.get("katakanaBoundary", False)
                if "requires" not in value and katakana_boundary is not True:
                    raise ValueError("Invalid ASR lexicon alias")
            else:
                alias, alias_cues = value, entry_cues
                katakana_boundary = False
            if (not _string(alias) or not isinstance(katakana_boundary, bool)
                    or (katakana_boundary and not KATAKANA.fullmatch(alias))):
                raise ValueError("Invalid ASR lexicon alias")
            if alias == term or alias in aliases:
                raise ValueError("Duplicate ASR lexicon alias")
            aliases.add(alias)
            if profile != "off" and (profile == "gakumas" or entry.get("scope") != "gakumas"):
                rules.append((alias, term, alias_cues, katakana_boundary))
    if terms.intersection(aliases):
        raise ValueError("ASR lexicon cannot cascade replacements")
    return terms, rules


class DomainCorrector:
    def __init__(self, profile: str | list[str] = "gakumas", path: str | Path | None = None):
        if path is not None and profile not in PROFILES:
            raise ValueError("Use either ASR packs or a custom lexicon")
        if path is None:
            sources = [_read(BUILTIN / f"{pack}.json") for pack in normalize_packs(profile)]
        else:
            sources = [_read(Path(path), profile)]

        terms = set().union(*(terms for terms, _ in sources))
        self.rules = sorted((rule for _, rules in sources for rule in rules), key=lambda rule: -len(rule[0]))
        targets = {}
        for alias, term, _, _ in self.rules:
            if targets.setdefault(alias, term) != term:
                raise ValueError("Conflicting ASR lexicon alias across packs")
        if terms.intersection(targets):
            raise ValueError("ASR lexicon cannot cascade replacements")
        self.canonical = sorted(terms, key=len, reverse=True)
        self.rule_index, self.term_index = {}, {}
        for rule in self.rules:
            self.rule_index.setdefault(rule[0][0], []).append(rule)
        for term in self.canonical:
            self.term_index.setdefault(term[0], []).append(term)

    @staticmethod
    def _latin(char: str) -> bool:
        return bool(char) and char.isascii() and (char.isalnum() or char == "_")

    def correct(self, text: str) -> str:
        if not self.rules or len(text) > 8192:
            return text
        result, offset = [], 0
        while offset < len(text):
            protected = next((term for term in self.term_index.get(text[offset], ()) if text.startswith(term, offset)), None)
            match = None
            for alias, term, cues, katakana_boundary in self.rule_index.get(text[offset], ()):
                if not text.startswith(alias, offset):
                    continue
                end = offset + len(alias)
                left, right = text[max(0, offset - 1):offset], text[end:end + 1]
                if self._latin(alias[0]) and self._latin(left) or self._latin(alias[-1]) and self._latin(right):
                    continue
                if katakana_boundary and (KATAKANA.fullmatch(left) or KATAKANA.fullmatch(right)):
                    continue
                if cues is not None:
                    before = SENTENCE_BREAK.split(text[max(0, offset - RADIUS):offset])[-1]
                    after = SENTENCE_BREAK.split(text[end:end + RADIUS], maxsplit=1)[0]
                    if not any(cue in before or cue in after for cue in cues):
                        continue
                match = (alias, term)
                break
            if protected and (not match or len(protected) >= len(match[0])):
                result.append(protected)
                offset += len(protected)
            elif match:
                result.append(match[1])
                offset += len(match[0])
            else:
                result.append(text[offset])
                offset += 1
        return "".join(result)
