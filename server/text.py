"""Japanese text post-processing and subtitle stability helpers."""
from __future__ import annotations

import re

CJK = r"\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef"
_RE_SPACE_BETWEEN_CJK = re.compile(rf"(?<=[{CJK}])[ \t]+(?=[{CJK}])")
_RE_SPACE_AROUND_CJK = re.compile(rf"(?<=[{CJK}])[ \t]+(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])[ \t]+(?=[{CJK}])")
_RE_MULTI_SPACE = re.compile(r"[ \t]{2,}")


def normalize_ja(text: str) -> str:
    """SenseVoice emits sub-word markers as spaces; Japanese has no word spacing."""
    if not text:
        return ""
    t = text.replace("\u3000", " ").strip()
    t = _RE_SPACE_BETWEEN_CJK.sub("", t)
    t = _RE_SPACE_AROUND_CJK.sub("", t)
    t = _RE_MULTI_SPACE.sub(" ", t)
    t = t.replace(" ,", "、").replace(" .", "。")
    return t.strip()


def longest_common_prefix(a: str, b: str) -> str:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    # Do not cut in the middle of a latin word: subtitles would flicker.
    while 0 < i < len(a) and a[i - 1].isascii() and a[i - 1].isalnum() and i < len(b) and b[i].isascii() and b[i].isalnum():
        i -= 1
    return a[:i]


def stable_prefix(prev: str, cur: str) -> str:
    """Text that both hypotheses agree on; the tail may still change."""
    if not prev:
        return cur
    if cur.startswith(prev):
        return prev
    return longest_common_prefix(prev, cur)


_END_PUNCT = "。！？!?…」』）)"


def looks_complete(text: str) -> bool:
    return bool(text) and text[-1] in _END_PUNCT


def trim_overlap(previous: str, current: str) -> str:
    """Remove a short exact continuation shared by two overlapping decodes."""
    for size in range(min(8, len(previous), len(current) - 1), 2, -1):
        if previous[-size:] == current[:size] and current[size:].strip():
            return current[size:].lstrip()
    return current


def clean_translation(text: str) -> str:
    t = (text or "").strip()
    t = re.sub(r"^(译文|翻译|中文)[:：]\s*", "", t)
    t = t.strip().strip('"“”')
    t = re.sub(r"\s*\n+\s*", " ", t)
    return t.strip()
