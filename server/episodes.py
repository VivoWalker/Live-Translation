"""Resolve local program metadata against curated, provenance-bearing terms."""
from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from .asr_domain import BUILTIN, MAX_BYTES, PACKS, DomainCorrector, EpisodeTerm, _string, normalize_packs


def _source(value):
    if isinstance(value, str) and len(value) <= 300:
        url = urlsplit(value)
        if url.scheme == "https" and url.hostname and not url.username and not url.password:
            return value
    raise ValueError("Episode records require an HTTPS source")


def _fold(value):
    return unicodedata.normalize("NFKC", value).lower()


@dataclass(frozen=True)
class DomainSelection:
    mode: str
    packs: tuple[str, ...] | None = None
    corrector: DomainCorrector | None = None
    episode: str = ""
    franchise: str = ""
    source: str = ""
    terms: tuple[EpisodeTerm, ...] = ()

    @property
    def prompt_terms(self) -> tuple[str, ...]:
        return tuple(term.canonical for term in self.terms if term.verified)

    def public(self) -> dict:
        return {"mode": self.mode, "packs": self.packs, "episode": self.episode,
                "franchise": self.franchise, "source": self.source}


@lru_cache(maxsize=32)
def _pack_corrector(packs):
    return DomainCorrector(list(packs))


class EpisodeCatalog:
    def __init__(self, path: str | Path | None = None):
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
            matches, terms = entry.get("title_contains"), entry.get("terms", [])
            if ((episode and not _string(episode)) or not isinstance(episode, str) or not _string(franchise)
                    or pack not in PACKS or not isinstance(matches, list) or not 1 <= len(matches) <= 8
                    or not all(_string(match, 3) for match in matches) or not isinstance(terms, list) or len(terms) > 32):
                raise ValueError("Invalid episode entry")
            source = _source(entry.get("source"))
            terms = tuple(self._term(term, source) for term in terms)
            selection = DomainSelection("auto", (pack,), DomainCorrector([pack], episode_terms=terms),
                                        episode, franchise, source, terms)
            self.matches.extend((_fold(match), selection) for match in matches)
        self.matches.sort(key=lambda item: -len(item[0]))

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

    def resolve(self, mode, *, title="", packs=None) -> DomainSelection:
        if mode == "auto":
            if not isinstance(title, str) or len(title) > 240:
                raise ValueError("Invalid episode title")
            title = _fold(title)
            for match, selection in self.matches:
                if match in title:
                    return selection
            return DomainSelection(mode, (), _pack_corrector(()))
        if mode == "off":
            return DomainSelection(mode, (), _pack_corrector(()))
        if mode == "manual":
            if packs is None:
                return DomainSelection(mode)
            enabled = normalize_packs(packs)
            return DomainSelection(mode, enabled, _pack_corrector(enabled))
        raise ValueError("Invalid domain mode")
