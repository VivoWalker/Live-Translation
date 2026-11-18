"""Measure the authenticated local WebSocket end to end."""
from __future__ import annotations

import asyncio
import json
import math
import time

import numpy as np

from server.asr import SAMPLE_RATE, resample_to_16k
from server.benchmark import latency_summary, rate

FRAME = SAMPLE_RATE // 10
CLOSE_REASONS = {"Subtitle output queue exceeded", "ASR audio backlog exceeded", "Subtitle client could not keep up",
                 "Subtitle backpressure", "Audio processing failed"}


def load_audio(path):
    import soundfile as sf

    audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    return resample_to_16k(audio.mean(axis=1), sample_rate)


async def stream_clip(clip, url, token, target, speed, include_text, configuration):
    import websockets

    audio = load_audio(clip.audio)
    silence = np.zeros(round(SAMPLE_RATE * 1.6), dtype=np.float32)
    samples = np.concatenate((audio, silence))
    finals, translations, failed = {}, {}, set()
    stats, ready = {}, {}
    finalized, verification = {}, []
    duplicates = 0
    sent_times = []
    complete = False
    close_code = None
    close_reason = ""

    async def read(ws):
        nonlocal stats, duplicates
        async for message in ws:
            event = json.loads(message)
            now = time.perf_counter()
            kind, segment = event["type"], event.get("id")
            if kind == "final":
                if segment in finals:
                    duplicates += 1
                    continue
                finals[segment] = (now, event.get("text", "") if include_text else "")
                frame_index = max(0, math.ceil(event["t"] * SAMPLE_RATE / FRAME) - 1)
                if sent_times:
                    finalized[segment] = max(0., now - sent_times[min(frame_index, len(sent_times) - 1)]) * 1000
                if "verification_wait_ms" in event:
                    verification.append(event["verification_wait_ms"])
            elif kind == "translation" and segment not in translations:
                translations[segment] = (now, event.get("text", "") if include_text else "")
            elif kind == "translation_cancelled" or (kind == "error" and event.get("scope") == "translate"):
                failed.add(segment)
            elif kind == "stats":
                stats = event

    try:
        async with websockets.connect(url, open_timeout=5, close_timeout=2) as ws:
            await ws.send(json.dumps({"type": "auth", "token": token}))
            ready = json.loads(await asyncio.wait_for(ws.recv(), 6))
            if ready.get("type") != "ready":
                raise ValueError("Benchmark service did not authenticate")
            config = {"type": "config", "target": target, **configuration}
            if config.get("domain", "auto" if clip.title else None) == "auto":
                config.update(domain="auto", page_title=clip.title)
            await ws.send(json.dumps(config))
            config_reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
            if config_reply.get("type") != "config" or not config_reply.get("ok"):
                raise ValueError("Benchmark service did not accept the translation configuration")
            last_send = time.perf_counter()
            reader = asyncio.create_task(read(ws))
            try:
                for index in range(0, len(samples), FRAME):
                    frame = samples[index:index + FRAME]
                    interval = len(frame) / SAMPLE_RATE / speed
                    await asyncio.sleep(max(0., last_send + interval - time.perf_counter()))
                    last_send = time.perf_counter()
                    sent_times.append(last_send)
                    await ws.send(frame.astype("<f4", copy=False).tobytes())
                deadline = time.perf_counter() + 30
                while time.perf_counter() < deadline and not reader.done():
                    await ws.send('{"type":"stats"}')
                    await asyncio.sleep(.15)
                    processed = stats.get("audio_processed_seconds", 0)
                    if (processed >= len(samples) / SAMPLE_RATE - .04
                            and not stats.get("translation", {}).get("deliveries_in_flight", 0)
                            and finals.keys() <= (translations.keys() | failed)):
                        complete = True
                        break
                close_code = ws.close_code
                close_reason = ws.close_reason or ""
            finally:
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)
    except websockets.ConnectionClosed as error:
        close_code = error.rcvd.code if error.rcvd else 1006
        close_reason = error.rcvd.reason if error.rcvd else ""
    except (OSError, TimeoutError):
        pass

    translated = [(translations[key][0] - at) * 1000 for key, (at, _) in finals.items() if key in translations]
    end_to_end = [finalized[key] + (translations[key][0] - finals[key][0]) * 1000
                  for key in finalized.keys() & translations.keys()]
    report = {"id": clip.id, "authenticated": ready.get("type") == "ready", "complete": complete,
              "close_code": close_code, "close_reason": close_reason if close_reason in CLOSE_REASONS else None,
              "finals": len(finals), "translations": len(finals.keys() & translations.keys()),
              "duplicate_finals": duplicates, "verification_wait_ms": sum(verification), "verification_wait_samples": len(verification),
              "server_finals": stats.get("finals"), "avg_decode_ms": stats.get("avg_decode_ms"), "rtf": stats.get("rtf"),
              "ws_queue_overflows": max(int(close_reason == "Subtitle output queue exceeded"), stats.get("queue", {}).get("overflows", 0)),
              "audio_queue_overflows": 1 if close_reason == "ASR audio backlog exceeded" else stats.get("audio_overflows"),
              "queue_peak": stats.get("queue", {}).get("peak_depth"),
              "dropped_partial_count": stats.get("queue", {}).get("dropped_partial_count"),
              "model": ready.get("asr"), "translator": ready.get("translator"), "agent": stats.get("agent", {}),
              "decode_ms": stats.get("decode_ms"), "audio_seconds": stats.get("audio_seconds"),
              "translation_timeouts": stats.get("translation_timeouts", 0),
              "translation_overflows": stats.get("translation_overflows", 0)}
    if include_text:
        report["transcript"] = "".join(finals[key][1] for key in sorted(finals))
        report["translation_text"] = " ".join(translations[key][1] for key in sorted(translations))
    return report, tuple(finalized.values()), translated, verification, end_to_end


async def stream_dataset(dataset, url, token, target, speed, include_text, sample_memory, configuration=None):
    configuration = configuration or {}
    rows, finals, translations, verification, end_to_end = [], [], [], [], []
    for clip in dataset.clips:
        report, fin, tr, vr, e2e = await stream_clip(clip, url, token, target, speed, include_text, configuration)
        rows.append(report)
        finals.extend(fin)
        translations.extend(tr)
        verification.extend(vr)
        end_to_end.extend(e2e)
        sample_memory()
    reliable = [row for row in rows if row["server_finals"] is not None and row["complete"]]
    generated = sum(row["server_finals"] for row in reliable)
    dropped = sum(max(0, row["server_finals"] - row["finals"]) for row in reliable)
    received = sum(row["finals"] for row in rows)
    delivered = sum(row["translations"] for row in rows)
    recovery = [(before, after) for before, after in zip(rows, rows[1:]) if not before["complete"]]
    agent = {key: sum(row["agent"].get(key, 0) for row in rows) for key in (
        "segments_total", "secondary_attempts", "secondary_timeouts", "secondary_corrections_accepted")}
    attempts = agent["secondary_attempts"]
    measured = [row for row in rows if row["decode_ms"] is not None and row["audio_seconds"]]
    return {
        "target": target, "audio_speed": speed, "clips": rows, "configuration": configuration,
        "finalization_latency": latency_summary(finals), "translation_latency": latency_summary(translations),
        "verification_latency": latency_summary(verification), "end_to_end_latency": latency_summary(end_to_end),
        "mean_agent_added_ms": rate(sum(verification), len(verification)),
        "agent": {**agent, "trigger_rate": rate(attempts, agent["segments_total"]),
                  "timeout_rate": rate(agent["secondary_timeouts"], attempts),
                  "correction_acceptance_rate": rate(agent["secondary_corrections_accepted"], attempts)},
        "translation_timeout_rate": rate(sum(row["translation_timeouts"] for row in rows), received),
        "asr_rtf": rate(sum(row["decode_ms"] for row in measured) / 1000,
                        sum(row["audio_seconds"] for row in measured)),
        "dropped_final_rate": rate(dropped, generated), "missing_translation_rate": rate(received - delivered, received),
        "duplicate_finals": sum(row["duplicate_finals"] for row in rows),
        "ws_queue_overflows": sum(row["ws_queue_overflows"] for row in rows),
        "audio_queue_overflows": sum(row["audio_queue_overflows"] or 0 for row in rows),
        "translation_queue_overflows": sum(row["translation_overflows"] for row in rows),
        "authenticated_sessions": sum(row["authenticated"] for row in rows),
        "complete_sessions": sum(row["complete"] for row in rows),
        "recovery_attempts": len(recovery), "successful_recoveries": sum(after["complete"] for _, after in recovery),
    }
