"""Resolve local program metadata against curated, provenance-bearing terms."""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from .asr_domain import BUILTIN, MAX_BYTES, PACKS, DomainCorrector, EpisodeTerm, _string, normalize_packs


def _source(value):
    if (isinstance(value, str) and len(value) <= 300 and value == value.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in value)):
        url = urlsplit(value)
        _ = url.port
        if url.scheme == "https" and url.hostname and not url.username and not url.password:
            return value
    raise ValueError("Episode records require an HTTPS source")


def _fold(value):
    return " ".join(unicodedata.normalize("NFKC", value).lower().split())


def _title_pattern(value):
    value = _fold(value)
    ascii_word = r"[a-z0-9_]"
    left = f"(?<!{ascii_word})" if re.fullmatch(ascii_word, value[0]) else ""
    right = f"(?!{ascii_word})" if re.fullmatch(ascii_word, value[-1]) else ""
    return re.compile(left + re.escape(value) + right)


@dataclass(frozen=True)
class DomainSelection:
    mode: str
    packs: tuple[str, ...] | None = None
    corrector: DomainCorrector | None = None
    episode: str = ""
    franchise: str = ""
    source: str = ""
    terms: tuple[EpisodeTerm, ...] = ()
    match: str = ""

    @property
    def prompt_terms(self) -> tuple[str, ...]:
        return tuple(term.canonical for term in self.terms if term.verified)

    def public(self) -> dict:
        return {"mode": self.mode, "packs": self.packs, "episode": self.episode,
                "franchise": self.franchise, "source": self.source, "match": self.match}


@lru_cache(maxsize=32)
def _pack_corrector(packs, conservative=False):
    return DomainCorrector(list(packs), conservative=conservative)


class EpisodeCatalog:
    def __init__(self, path: str | Path | None = None, *, fallback_packs=None, general_fallback=False):
        if type(general_fallback) is not bool:
            raise ValueError("Invalid general fallback setting")
        self.fallback_packs = normalize_packs(fallback_packs) if fallback_packs is not None else ()
        self.general_fallback = general_fallback
        with Path(path or BUILTIN / "episodes.json").open("rb") as file:
            raw = file.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Episode catalog is too large")
        data = json.loads(raw)
        if (not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("episodes"), list)
                or len(data["episodes"]) > 64):
            raise ValueError("Invalid episode catalog")
        self.matches = []
        for entry in data["episodes"]:
            if not isinstance(entry, dict):
                raise ValueError("Invalid episode entry")
            episode, franchise, pack = entry.get("episode", ""), entry.get("franchise"), entry.get("pack")
            matches, exact = entry.get("title_contains", []), entry.get("title_exact", [])
            terms = entry.get("terms", [])
            verified = entry.get("verified", True)
            scope = entry.get("scope", "episode" if episode else "franchise")
            if ((episode and not _string(episode)) or not isinstance(episode, str) or not _string(franchise)
                    or pack not in PACKS or not isinstance(matches, list) or not isinstance(exact, list)
                    or not 1 <= len(matches) + len(exact) <= 8
                    or not all(_string(match, 3) for match in (*matches, *exact))
                    or not isinstance(terms, list) or len(terms) > 32 or type(verified) is not bool
                    or scope not in ("episode", "franchise") or (scope == "episode") != bool(episode)):
                raise ValueError("Invalid episode entry")
            source = _source(entry.get("official_source", entry.get("source")))
            terms = tuple(self._term(term, source) for term in terms)
            if not verified:
                continue
            if scope != "episode":
                terms = ()  # Title-level franchise matches enable only the curated pack.
            selection = DomainSelection("auto", (pack,), DomainCorrector([pack], episode_terms=terms),
                                        episode, franchise, source, terms, match=scope)
            self.matches.append((tuple(_title_pattern(match) for match in matches),
                                 frozenset(_fold(match) for match in exact), selection))

    @staticmethod
    def _term(term, source):
        if not isinstance(term, dict):
            raise ValueError("Invalid episode term")
        canonical, reading = term.get("canonical"), term.get("reading", "")
        category, priority = term.get("category", "other"), term.get("priority", "normal")
        verified, aliases = term.get("verified", False), term.get("aliases", [])
        if (not _string(canonical) or not isinstance(reading, str) or (reading and not _string(reading))
                or not _string(category, 1) or priority not in ("normal", "high") or type(verified) is not bool
                or not isinstance(aliases, list) or len(aliases) > 8 or not all(_string(alias, 3) for alias in aliases)):
            raise ValueError("Invalid episode term")
        return EpisodeTerm(canonical, reading, category, priority, verified, _source(term.get("source", source)),
                           tuple(aliases))

    def resolve(self, mode, *, title="", packs=None, general=None) -> DomainSelection:
        if mode == "auto":
            if not isinstance(title, str) or len(title) > 240 or (general is not None and type(general) is not bool):
                raise ValueError("Invalid episode title")
            manual = self.fallback_packs if packs is None else normalize_packs(packs)
            use_general = self.general_fallback if general is None else general
            title = _fold(title)
            matches = [selection for patterns, exact, selection in self.matches
                       if title in exact or any(pattern.search(title) for pattern in patterns)]
            exact = [selection for selection in matches if selection.episode]
            choices = exact or matches
            if len(choices) == 1:
                return choices[0]
            if manual:
                return DomainSelection(mode, manual, _pack_corrector(manual), match="manual_fallback")
            if use_general:
                return DomainSelection(mode, ("general",), _pack_corrector(("general",), True), match="general_fallback")
            return DomainSelection(mode, (), _pack_corrector(()), match="ambiguous" if choices else "unmatched")
        if mode == "off":
            return DomainSelection(mode, (), _pack_corrector(()), match="off")
        if mode == "manual":
            if packs is None:
                return DomainSelection(mode, match="manual")
            enabled = normalize_packs(packs)
            return DomainSelection(mode, enabled, _pack_corrector(enabled), match="manual")
        raise ValueError("Invalid domain mode")
