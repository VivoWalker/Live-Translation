"""Stateless domain spelling correction, sharing the browser's bounded lexicon."""
from __future__ import annotations

import json
from pathlib import Path

PROFILES = ("off", "anime", "gakumas")
BUILTIN = Path(__file__).resolve().parent.parent / "extension" / "asr-terms.json"
MAX_BYTES = 256 * 1024


def _string(value, minimum: int = 2) -> bool:
    return (isinstance(value, str) and minimum <= len(value) <= 80 and value == value.strip()
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


class DomainCorrector:
    def __init__(self, profile: str = "gakumas", path: str | Path | None = None):
        if profile not in PROFILES:
            raise ValueError("Unknown ASR domain")
        self.profile = profile
        with Path(path or BUILTIN).open("rb") as source:
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
        self.cues = data["cues"]
        for values in self.cues.values():
            if not isinstance(values, list) or len(values) > 40 or not all(_string(value, 1) for value in values):
                raise ValueError("Invalid ASR lexicon cues")
        aliases, terms = {}, set()
        for entry in data["entries"]:
            if (not isinstance(entry, dict) or not _string(entry.get("term"))
                    or entry.get("scope") not in ("common", "gakumas")
                    or not isinstance(entry.get("aliases"), list) or len(entry["aliases"]) > 12
                    or not all(map(_string, entry["aliases"]))
                    or ("requires" in entry and (not isinstance(entry["requires"], list) or not entry["requires"] or len(entry["requires"]) > 16
                        or not all(isinstance(c, str) and c in self.cues for c in entry["requires"])))):
                raise ValueError("Invalid ASR lexicon entry")
            terms.add(entry["term"])
            for alias in entry["aliases"]:
                if alias == entry["term"] or alias in aliases:
                    raise ValueError("Duplicate ASR lexicon alias")
                aliases[alias] = entry
        if terms.intersection(aliases):
            raise ValueError("ASR lexicon cannot cascade replacements")
        self.rules = sorted(((alias, entry) for alias, entry in aliases.items()
                             if profile != "off" and (profile == "gakumas" or entry["scope"] == "common")),
                            key=lambda rule: -len(rule[0]))
        self.canonical = sorted(terms, key=len, reverse=True)
        self.rule_index, self.term_index = {}, {}
        for alias, entry in self.rules:
            self.rule_index.setdefault(alias[0], []).append((alias, entry))
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
            for alias, entry in self.rule_index.get(text[offset], ()):
                if not text.startswith(alias, offset):
                    continue
                before, after = text[max(0, offset - 1):offset], text[offset + len(alias):offset + len(alias) + 1]
                if self._latin(alias[0]) and self._latin(before) or self._latin(alias[-1]) and self._latin(after):
                    continue
                near = text[max(0, offset - 24):offset] + text[offset + len(alias):offset + len(alias) + 24]
                if "requires" in entry and not any(cue in near for name in entry["requires"] for cue in self.cues[name]):
                    continue
                match = (alias, entry)
                break
            if protected and (not match or len(protected) >= len(match[0])):
                result.append(protected); offset += len(protected)
            elif match:
                result.append(match[1]["term"]); offset += len(match[0])
            else:
                result.append(text[offset]); offset += 1
        return "".join(result)
