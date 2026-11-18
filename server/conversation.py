"""Bounded Japanese dialogue history and target-specific translation terminology."""
from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from .asr_domain import BUILTIN, _string

CONTEXT_WINDOWS = (1, 3, 4, 5)
TURN_LIMIT = 512
GLOSSARY_LIMIT = 32 * 1024


@dataclass(frozen=True)
class Glossary:
    version: str = ""
    zh: tuple[tuple[str, str], ...] = ()
    en: tuple[tuple[str, str], ...] = ()

    @classmethod
    def load(cls, path: str | None = None):
        with Path(path or BUILTIN / "translation.json").open("rb") as file:
            raw = file.read(GLOSSARY_LIMIT + 1)
        if len(raw) > GLOSSARY_LIMIT:
            raise ValueError("Translation glossary is too large")
        data = json.loads(raw)
        if not isinstance(data, dict) or not _string(data.get("version"), 1):
            raise ValueError("Invalid translation glossary version")
        tables = []
        for language in ("zh", "en"):
            table = data.get(language, {})
            if (not isinstance(table, dict) or len(table) > 256
                    or not all(_string(key, 1) and _string(value, 1) for key, value in table.items())):
                raise ValueError("Invalid translation glossary")
            tables.append(tuple(sorted(table.items(), key=lambda pair: (-len(pair[0]), pair[0]))))
        return cls(data["version"], *tables)

    def relevant(self, target, texts):
        entries = self.en if target == "en" else self.zh
        return tuple((key, value) for key, value in entries if any(key in text for text in texts))[:8]


@dataclass(frozen=True)
class ConversationSnapshot:
    previous: str
    history: tuple[str, ...]
    episode: str = ""
    franchise: str = ""
    glossary_version: str = ""
    glossary: tuple[tuple[str, str], ...] = ()

    def payload(self, current: str) -> dict:
        data = {"previous": self.previous, "current": current, "history": self.history}
        if self.episode:
            data["episode"] = self.episode
        if self.franchise:
            data["franchise"] = self.franchise
        if self.glossary:
            data["glossary"] = dict(self.glossary)
        return data


class ConversationContext:
    def __init__(self):
        self.history = deque(maxlen=max(CONTEXT_WINDOWS))

    @property
    def previous(self) -> str:
        return self.history[-1] if self.history else ""

    def clear(self):
        self.history.clear()

    def remember(self, text):
        self.history.append(text[:TURN_LIMIT])

    def snapshot(self, text, target, turns, glossary, domain=None) -> str | ConversationSnapshot:
        if turns == 1:
            return self.previous
        history = tuple(self.history)[-turns:]
        episode = domain.episode if domain else ""
        franchise = domain.franchise if domain else ""
        relevant = glossary.relevant(target, (text, *history, episode, franchise))
        return ConversationSnapshot(self.previous, history, episode, franchise, glossary.version, relevant)
