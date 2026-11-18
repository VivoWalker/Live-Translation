"""Stateless domain spelling correction, sharing the browser's bounded lexicons."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path

PROFILES = ("off", "anime", "gakumas")
PACKS = ("mashiro", "gakumas", "bandori", "lovelive", "general")
BUILTIN = Path(__file__).resolve().parent.parent / "extension" / "asr-terms"
MAX_BYTES = 256 * 1024
RADIUS = 24
# Keep punctuation attached to a Latin program name such as MyGO!!!!!.
SENTENCE_BREAK = re.compile(r"[。？?\r\n]|(?<![A-Za-z!！])[!！]+")
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


def _read(path: Path, profile: str = "gakumas", source: str = "custom", *, conservative=False):
    with path.open("rb") as file:
        raw = file.read(MAX_BYTES + 1)
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

    fallback = data.get("fallback", [])
    if not isinstance(fallback, list) or len(fallback) > 16 or not all(_string(name) for name in fallback):
        raise ValueError("Invalid ASR fallback terms")
    aliases, terms, rules = set(), set(), []
    for entry in data["entries"]:
        if (not isinstance(entry, dict) or not _string(entry.get("term"))
                or entry.get("scope", "common") not in ("common", "gakumas")
                or not isinstance(entry.get("aliases"), list) or len(entry["aliases"]) > 12):
            raise ValueError("Invalid ASR lexicon entry")
        entry_cues = context(entry["requires"]) if "requires" in entry else None
        term = entry["term"]
        verified, candidate = entry.get("verified", True), entry.get("candidate", False)
        if type(verified) is not bool or type(candidate) is not bool:
            raise ValueError("Invalid ASR lexicon evidence")
        if verified:
            terms.add(term)
        for value in entry["aliases"]:
            alias_verified, alias_candidate = verified, candidate
            if isinstance(value, dict):
                alias = value.get("text")
                alias_cues = context(value["requires"]) if "requires" in value else entry_cues
                katakana_boundary = value.get("katakanaBoundary", False)
                if not {"requires", "katakanaBoundary", "verified", "candidate"}.intersection(value):
                    raise ValueError("Invalid ASR lexicon alias")
                if type(value.get("verified", True)) is not bool or type(value.get("candidate", False)) is not bool:
                    raise ValueError("Invalid ASR lexicon evidence")
                alias_verified = verified and value.get("verified", True)
                alias_candidate = candidate or value.get("candidate", False)
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
                if alias_candidate or not alias_verified:
                    level, trigger = 3, "candidate_only"
                elif alias_cues is not None:
                    level, trigger = 2, "sentence_cue"
                else:
                    level, trigger = 1, "curated_alias"
                rules.append(Rule(alias, term, alias_cues, katakana_boundary, source, alias_verified, level, trigger))
    if terms.intersection(rule.alias for rule in rules if rule.level < 3):
        raise ValueError("ASR lexicon cannot cascade replacements")
    if conservative:
        fallback_cues = context(["broadcast"])
        return terms, [replace(rule, cues=fallback_cues, level=2, trigger="fallback_broadcast_cue")
                       for rule in rules if rule.level < 3 and rule.canonical in fallback]
    return terms, rules


@dataclass(frozen=True)
class EpisodeTerm:
    canonical: str
    reading: str
    category: str
    priority: str
    verified: bool
    source: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class Correction:
    alias: str
    canonical: str
    start: int
    end: int
    source: str
    verified: bool = True
    independent_asr: bool = False
    rule: str = "curated_alias"
    decision: str = "accepted"
    level: int = 1


@dataclass(frozen=True)
class Rule:
    alias: str
    canonical: str
    cues: tuple[str, ...] | None
    katakana_boundary: bool
    source: str
    verified: bool
    level: int
    trigger: str

    def evidence(self, start):
        return Correction(self.alias, self.canonical, start, start + len(self.alias), self.source,
                          self.verified, rule=self.trigger, level=self.level,
                          decision="suggested" if self.level == 3 else "accepted")


@lru_cache(maxsize=len(PACKS) + 1)
def _read_pack(pack, conservative=False):
    return _read(BUILTIN / f"{pack}.json", source=f"pack:{pack}", conservative=conservative)


class DomainCorrector:
    def __init__(self, profile: str | list[str] = "gakumas", path: str | Path | None = None, *,
                 episode_terms: tuple[EpisodeTerm, ...] = (), conservative=False):
        if path is not None and profile not in PROFILES:
            raise ValueError("Use either ASR packs or a custom lexicon")
        if path is None:
            sources = [_read_pack(pack, conservative and pack == "general") for pack in normalize_packs(profile)]
        else:
            sources = [_read(Path(path), profile)]
        for extra in episode_terms:
            rules = [Rule(alias, extra.canonical, None, False, extra.source, extra.verified,
                          2 if extra.verified else 3, "episode_scope" if extra.verified else "candidate_only")
                     for alias in extra.aliases if alias != extra.canonical]
            if extra.reading and extra.reading != extra.canonical and extra.reading not in extra.aliases:
                rules.append(Rule(extra.reading, extra.canonical, None, False, extra.source, extra.verified, 3,
                                  "episode_candidate" if extra.verified else "candidate_only"))
            sources.append(({extra.canonical} if extra.verified else set(), rules))

        terms = set().union(*(names for names, _ in sources))
        self.rules = self._resolve_rules((rule for _, rules in sources for rule in rules), terms)
        self.rule_index, self.term_index = {}, {}
        for rule in self.rules:
            self.rule_index.setdefault(rule.alias[0], []).append(rule)
        for term in sorted(terms, key=lambda term: (-len(term), term)):
            self.term_index.setdefault(term[0], []).append(term)

    @staticmethod
    def _resolve_rules(rules, canonical):
        grouped = {}
        for rule in rules:
            if rule.alias not in canonical:
                grouped.setdefault(rule.alias, []).append(rule)
        resolved = []
        for group in grouped.values():
            if len({rule.canonical for rule in group if rule.verified}) > 1:
                resolved.extend(replace(rule, level=3, trigger="conflicting_alias") for rule in group)
            elif any(rule.verified and rule.level == 3 for rule in group):
                resolved.extend(rule for rule in group if rule.level == 3)
            else:
                resolved.extend(group)
        return sorted(dict.fromkeys(resolved), key=lambda rule: (-len(rule.alias), rule.level))

    @staticmethod
    def _latin(char: str) -> bool:
        return bool(char) and char.isascii() and (char.isalnum() or char == "_")

    def correct(self, text: str) -> str:
        return self.explain(text)[0]

    def explain(self, text: str) -> tuple[str, tuple[Correction, ...]]:
        corrected, changes, _ = self.inspect(text)
        return corrected, changes

    def inspect(self, text: str) -> tuple[str, tuple[Correction, ...], tuple[Correction, ...]]:
        if not self.rules or len(text) > 8192:
            return text, (), ()
        result, changes, candidates, offset = [], [], [], 0
        while offset < len(text):
            protected = next((term for term in self.term_index.get(text[offset], ()) if text.startswith(term, offset)), None)
            match = None
            for rule in self.rule_index.get(text[offset], ()):
                alias = rule.alias
                if (not text.startswith(alias, offset) or (protected and len(protected) >= len(alias))):
                    continue
                end = offset + len(alias)
                left, right = text[max(0, offset - 1):offset], text[end:end + 1]
                if self._latin(alias[0]) and self._latin(left) or self._latin(alias[-1]) and self._latin(right):
                    continue
                if rule.katakana_boundary and (KATAKANA.fullmatch(left) or KATAKANA.fullmatch(right)):
                    continue
                if rule.cues is not None:
                    before = SENTENCE_BREAK.split(text[max(0, offset - RADIUS):offset])[-1]
                    after = SENTENCE_BREAK.split(text[end:end + RADIUS], maxsplit=1)[0]
                    if not any(cue in before or cue in after for cue in rule.cues):
                        continue
                if rule.level == 3:
                    if len(candidates) < 32:
                        candidates.append(rule.evidence(offset))
                    continue
                match = rule
                break
            if match:
                change = match.evidence(offset)
                changes.append(change)
                result.append(change.canonical)
                offset = change.end
            else:
                chunk = protected or text[offset]
                result.append(chunk)
                offset += len(chunk)
        return "".join(result), tuple(changes), tuple(candidates)
