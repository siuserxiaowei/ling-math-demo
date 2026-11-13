#!/usr/bin/env python3
"""Measure a lesson plan's real narration and prepare its visual/caption timeline.

Audio backend (default): per-segment audio WAV, or an audio-index.json beside
the plan / supplied with --audio-index. Paths in that index are relative to it.
The explicit macos backend uses installed say voices; it never calls an API.

Output paths are relative to narration.json. Segment start/end delimit visual
scenes; voiceStart/voiceEnd delimit actual PCM samples. Captions show plan.text,
never substitute spokenText, and remain until the segment's explicit tail hold.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unicodedata
import wave

from make_narration import (
    FORMULA_SYMBOLS, SINGLE_LETTER, SAMPLE_RATE, NarrationError, check_pcm,
    installed_voice, probe_duration, run, sha256_file, timestamp,
)


PUNCTUATION = set("，。！？；：、,.!?;:")
PROVENANCE_FIELDS = ("provider", "model", "voice", "transportMode", "source")
TEACHING_FIELDS = {"mode", "grade", "learningGoal", "misconception", "prerequisites", "check", "adultTips"}
CHECK_FIELDS = {"questionSegmentId", "answerSegmentId", "question", "expectedAnswer", "explanation", "pauseSeconds"}


def read_json(path: Path) -> dict:
    def reject_constant(value: str):
        raise ValueError(f"JSON 不允许 {value}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)
    except (OSError, UnicodeError, ValueError) as exc:
        raise NarrationError(f"无法读取 {path.name}：{exc}") from exc
    if not isinstance(data, dict):
        raise NarrationError(f"{path.name} 的顶层必须是 JSON 对象。")
    return data


def segment_id(value, where: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise NarrationError(f"{where} 的 id 必须是字符串或整数。")
    result = str(value).strip()
    if not result:
        raise NarrationError(f"{where} 的 id 不能为空。")
    return result


def half_width(text: str) -> int:
    """Chinese/fullwidth characters count as 2, ASCII as 1, combining as 0."""
    return sum(0 if unicodedata.combining(char) else 1 if ord(char) < 128 else 2 for char in text)


def caption_lines(text: str, width: int = 18) -> list[str]:
    """Break one short cue into at most two lines; never invent word timings."""
    limit = width * 2
    if "\n" in text or "\r" in text:
        lines = [line.strip() for line in text.splitlines()]
        if not 1 <= len(lines) <= 2 or any(not line or half_width(line) > limit for line in lines):
            raise NarrationError("字幕需为1–2行，每行不超过指定中文宽度，且不能含空行。")
        return lines
    if half_width(text) <= limit:
        return [text]
    candidates = []
    for offset in range(1, len(text)):
        left, right = text[:offset].rstrip(), text[offset:].lstrip()
        if not left or not right or max(half_width(left), half_width(right)) > limit:
            continue
        punctuation = left[-1] in PUNCTUATION
        awkward = right[0] in PUNCTUATION or left[-1] in "=+×÷−(（" or right[0] in ")）"
        candidates.append(((awkward, not punctuation, abs(half_width(left) - half_width(right))), [left, right]))
    if not candidates:
        raise NarrationError(
            f"字幕太长，无法放入两行（每行约{width}个中文字，ASCII半宽）。"
            "请让脚本生成者缩短本段 text，或把计划拆成多个短段并重新配音；"
            "不会均摊现有音频来伪造逐字时间。"
        )
    return min(candidates, key=lambda item: item[0])[1]


def validate_teaching(plan: dict, segments: list[dict]) -> dict | None:
    """Validate optional teaching metadata before any synthesis or file writes.

    This establishes safe timing references, not mathematical correctness or a
    proof that a question measures learning. Legacy plans may omit the field.
    """
    if "teaching" not in plan:
        return None
    teaching = plan["teaching"]
    if not isinstance(teaching, dict) or set(teaching) != TEACHING_FIELDS:
        raise NarrationError("teaching 需要完整且仅有约定的教学字段。")
    if teaching["mode"] not in ("parent", "teacher"):
        raise NarrationError("teaching.mode 必须是 parent 或 teacher。")
    for key in ("grade", "learningGoal", "misconception"):
        if not isinstance(teaching[key], str) or not teaching[key].strip():
            raise NarrationError(f"teaching.{key} 需要非空字符串。")
    for key, minimum, maximum in (("prerequisites", 0, 6), ("adultTips", 2, 4)):
        values = teaching[key]
        if not isinstance(values, list) or not minimum <= len(values) <= maximum or any(not isinstance(value, str) or not value.strip() for value in values):
            raise NarrationError(f"teaching.{key} 需要 {minimum}–{maximum} 条非空字符串。")
    check = teaching["check"]
    if not isinstance(check, dict) or set(check) != CHECK_FIELDS:
        raise NarrationError("teaching.check 需要完整且仅有约定的问答字段。")
    for key in ("questionSegmentId", "answerSegmentId", "question", "expectedAnswer", "explanation"):
        if not isinstance(check[key], str) or not check[key].strip():
            raise NarrationError(f"teaching.check.{key} 需要非空字符串。")
    pause = check["pauseSeconds"]
    if type(pause) not in (int, float) or not math.isfinite(pause) or not 3 <= pause <= 15:
        raise NarrationError("teaching.check.pauseSeconds 必须是 3–15 秒的有限数值。")
    positions = {segment["id"]: number for number, segment in enumerate(segments)}
    question = positions.get(check["questionSegmentId"])
    answer = positions.get(check["answerSegmentId"])
    if question is None or answer is None or answer != question + 1:
        raise NarrationError("teaching.check 问题段和答案段必须存在，且答案段紧接问题段。")
    return teaching


def read_plan(path: Path, width: int) -> tuple[dict, list[dict]]:
    plan = read_json(path)
    if type(plan.get("schemaVersion")) is not int or plan["schemaVersion"] != 1:
        raise NarrationError("plan.json 需要 schemaVersion: 1。")
    for key in ("title", "topic", "audience"):
        if not isinstance(plan.get(key), str) or not plan[key].strip():
            raise NarrationError(f"plan.json 需要非空字符串 {key}。")
    raw_segments = plan.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise NarrationError("plan.json 的 segments 必须是非空数组。")
    seen, result = set(), []
    for number, raw in enumerate(raw_segments, 1):
        if not isinstance(raw, dict):
            raise NarrationError(f"第{number}段不是对象。")
        ident = segment_id(raw.get("id"), f"第{number}段")
        if ident in seen:
            raise NarrationError(f"重复段 id：{ident}")
        seen.add(ident)
        for key in ("text", "spokenText"):
            if not isinstance(raw.get(key), str) or not raw[key].strip():
                raise NarrationError(f"段 {ident} 需要非空 {key}（字幕与中文读音稿分开）。")
        text, spoken = raw["text"].strip(), raw["spokenText"].strip()
        if FORMULA_SYMBOLS.search(spoken) or SINGLE_LETTER.search(spoken):
            raise NarrationError(f"段 {ident} 的 spokenText 含公式或变量；请写成中文读法，例如‘派乘半径的平方’。")
        if not isinstance(raw.get("visual"), dict):
            raise NarrationError(f"段 {ident} 需要 visual 对象。")
        try:
            lines = caption_lines(text, width)
        except NarrationError as exc:
            raise NarrationError(f"段 {ident}：{exc}") from exc
        item = copy.deepcopy(raw)
        item.update(id=ident, text=text, spokenText=spoken, lines=lines)
        result.append(item)
    validate_teaching(plan, result)
    return plan, result


def resolve_file(value, base: Path, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise NarrationError(f"{label} 需要 WAV 路径。")
    path = Path(value).expanduser()
    path = (base / path).resolve() if not path.is_absolute() else path.resolve()
    if path.suffix.lower() != ".wav" or not path.is_file():
        raise NarrationError(f"{label} 的 WAV 不存在或扩展名不是 .wav。")
    return path


def index_sources(index_path: Path | None) -> tuple[dict, dict[str, dict]]:
    if index_path is None:
        return {}, {}
    index = read_json(index_path)
    if type(index.get("schemaVersion")) is not int or index["schemaVersion"] != 1 or not isinstance(index.get("segments"), list):
        raise NarrationError("audio-index.json 需要 schemaVersion:1 和 segments 数组。")
    entries = {}
    for raw in index["segments"]:
        if not isinstance(raw, dict):
            raise NarrationError("audio-index.json 中的每段必须是对象。")
        ident = segment_id(raw.get("id"), "audio-index 段")
        if ident in entries:
            raise NarrationError(f"audio-index.json 重复段 id：{ident}")
        entries[ident] = raw
    return index, entries


def media_provenance(global_data: dict, entry: dict) -> dict:
    result = {}
    for key in PROVENANCE_FIELDS:
        value = entry.get(key, global_data.get(key))
        if value is not None:
            if not isinstance(value, (str, int, float, bool)):
                raise NarrationError(f"音频来源字段 {key} 必须是简单标量。")
            result[key] = value
    if not result.get("model") and entry.get("requestModel"):
        result["model"] = str(entry["requestModel"])
    result.setdefault("provider", "provided-wav")
    return result


def audio_sources(plan_path: Path, segments: list[dict], index_path: Path | None) -> tuple[dict, list[dict]]:
    index, entries = index_sources(index_path)
    sources = []
    for item in segments:
        entry = entries.get(item["id"])
        if item.get("audio") is not None:
            source = resolve_file(item["audio"], plan_path.parent, f"段 {item['id']}")
            # Index provenance describes this file only when both paths agree.
            indexed_source = None
            if entry and index_path:
                try:
                    indexed_source = resolve_file(entry.get("audio"), index_path.parent, f"audio-index 段 {item['id']}")
                except NarrationError:
                    pass  # An explicit valid WAV takes precedence over a stale index entry.
            explicit_provenance = item.get("audioSource", {})
            if not isinstance(explicit_provenance, dict):
                raise NarrationError(f"段 {item['id']} 的 audioSource 必须是对象。")
            metadata = media_provenance(index, entry) if indexed_source == source else media_provenance({}, explicit_provenance)
        elif entry and index_path:
            source = resolve_file(entry.get("audio"), index_path.parent, f"audio-index 段 {item['id']}")
            metadata = media_provenance(index, entry)
        else:
            raise NarrationError(f"段 {item['id']} 没有 WAV。请提供段 audio、伴随 audio-index.json 或 --audio-index；本地合成需显式 --backend macos。")
        sources.append({"path": source, "metadata": metadata})
    return index, sources


def write_silence(dst, frame_count: int) -> None:
    while frame_count:
        count = min(frame_count, SAMPLE_RATE)
        dst.writeframesraw(b"\x00\x00" * count)
        frame_count -= count


def prepare(args: argparse.Namespace) -> dict:
    plan_path = Path(args.plan).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    if out_dir.exists() and (not out_dir.is_dir() or any(out_dir.iterdir())):
        raise NarrationError("输出目录已存在且非空，拒绝覆盖；请选择新的或空的目录。")
    plan, segments = read_plan(plan_path, args.line_width)
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise NarrationError("PATH 中需要 FFmpeg 和 FFprobe；本工具不会自动安装依赖。")
    index_path, sources, index = None, [], {}
    say = None
    if args.backend == "macos":
        if args.audio_index:
            raise NarrationError("--backend macos 会重新合成所有段，请勿同时传入 --audio-index。")
        if sys.platform != "darwin" or not (say := shutil.which("say")):
            raise NarrationError("macos 后端需要 macOS say；其他系统请使用 audio 后端和已有 WAV。")
        installed_voice(say, args.voice)
    else:
        index_path = Path(args.audio_index).expanduser().resolve() if args.audio_index else plan_path.parent / "audio-index.json"
        if not args.audio_index and not index_path.is_file():
            index_path = None
        index, sources = audio_sources(plan_path, segments, index_path)
    # Fail all known input checks before writing any media.
    out_dir.mkdir(parents=True, exist_ok=True)
    lock = out_dir / ".prepare-narration.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise NarrationError("输出目录正被另一进程使用。") from exc
    os.close(descriptor)
    try:
        records = []
        with tempfile.TemporaryDirectory(prefix="prepare-narration-") as scratch:
            for number, item in enumerate(segments, 1):
                if args.backend == "macos":
                    source = Path(scratch) / f"source-{number:02d}.aiff"
                    manuscript = Path(scratch) / f"source-{number:02d}.txt"
                    manuscript.write_text(item["spokenText"], encoding="utf-8")
                    run([say, "-v", args.voice, "-r", str(args.rate), "-o", str(source), "-f", str(manuscript)])
                    metadata = {"provider": "macos-say", "voice": args.voice, "rate": args.rate}
                else:
                    source, metadata = sources[number - 1]["path"], sources[number - 1]["metadata"]
                source_duration = probe_duration(ffprobe, source)
                source_sha = sha256_file(source)
                output = out_dir / f"segment-{number:02d}.wav"
                run([ffmpeg, "-n", "-v", "error", "-i", str(source), "-map", "0:a:0", "-vn", "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(output)])
                frames = check_pcm(output)
                measured = probe_duration(ffprobe, output)
                if abs(measured - frames / SAMPLE_RATE) > 1 / SAMPLE_RATE:
                    raise NarrationError(f"段 {item['id']} 的 PCM 帧数与 FFprobe 时长不一致。")
                record = {
                    "id": item["id"], "text": item["text"], "spokenText": item["spokenText"],
                    "visual": item["visual"], "lines": item["lines"], "audio": output.name,
                    "sampleFrames": frames, "duration": frames / SAMPLE_RATE, "actualDuration": measured,
                    "sourceDuration": source_duration, "sourceSha256": source_sha,
                    "sha256": sha256_file(output), **metadata,
                }
                record.setdefault("model", None)
                record.setdefault("voice", None)
                records.append(record)

        head_frames, gap_frames, tail_frames = (round(value * SAMPLE_RATE) for value in (args.head, args.gap, args.tail))
        teaching = plan.get("teaching")
        check = teaching["check"] if teaching else None
        thinking_frames = math.ceil(check["pauseSeconds"] * SAMPLE_RATE) if check else 0
        thinking_pauses = []
        combined = out_dir / "narration.wav"
        offset = 0
        with wave.open(str(combined), "wb") as dst:
            dst.setnchannels(1)
            dst.setsampwidth(2)
            dst.setframerate(SAMPLE_RATE)
            write_silence(dst, head_frames)
            offset += head_frames
            for number, item in enumerate(records):
                item["start"] = 0.0 if number == 0 else offset / SAMPLE_RATE
                item["voiceStart"] = offset / SAMPLE_RATE
                with wave.open(str(out_dir / item["audio"]), "rb") as src:
                    while chunk := src.readframes(SAMPLE_RATE):
                        dst.writeframesraw(chunk)
                offset += item["sampleFrames"]
                item["voiceEnd"] = offset / SAMPLE_RATE
                is_question = bool(check and item["id"] == check["questionSegmentId"])
                padding = tail_frames if number == len(records) - 1 else max(gap_frames, thinking_frames) if is_question else gap_frames
                write_silence(dst, padding)
                offset += padding
                item["end"] = offset / SAMPLE_RATE
                item["pauseAfter"] = padding / SAMPLE_RATE
                if is_question:
                    thinking_pauses.append({
                        "questionSegmentId": check["questionSegmentId"],
                        "answerSegmentId": check["answerSegmentId"],
                        "start": item["voiceEnd"], "end": item["end"],
                        "duration": padding / SAMPLE_RATE,
                        "requestedSeconds": check["pauseSeconds"],
                    })
            dst.writeframes(b"")
        total_frames = check_pcm(combined)
        measured = probe_duration(ffprobe, combined)
        if total_frames != offset or abs(measured - offset / SAMPLE_RATE) > 1 / SAMPLE_RATE:
            raise NarrationError("整轨 PCM 帧数、时间轴与 FFprobe 实测不一致。")
        run([ffmpeg, "-v", "error", "-i", str(combined), "-f", "null", "-"])
        cues = [{
            "id": item["id"], "segmentId": item["id"], "start": item["voiceStart"], "end": item["end"],
            "voiceStart": item["voiceStart"], "voiceEnd": item["voiceEnd"], "holdAfter": item["pauseAfter"],
            "text": item["text"], "lines": item["lines"],
        } for item in records]
        captions = {"schemaVersion": 1, "duration": offset / SAMPLE_RATE, "cues": cues}
        (out_dir / "captions.json").write_text(json.dumps(captions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        srt = []
        for number, cue in enumerate(cues, 1):
            caption = "\n".join(cue["lines"])
            srt.append(f"{number}\n{timestamp(cue['start'])} --> {timestamp(cue['end'])}\n{caption}\n")
        (out_dir / "captions.srt").write_text("\n".join(srt), encoding="utf-8")
        provenance = {item["provider"] for item in records}
        voices = {item.get("voice") for item in records}
        models = {item.get("model") for item in records}
        manifest = {
            "schemaVersion": 1, "title": plan["title"], "topic": plan["topic"], "audience": plan["audience"],
            "backend": args.backend, "provider": next(iter(provenance)) if len(provenance) == 1 else "mixed",
            "model": next(iter(models)) if len(models) == 1 else None, "voice": next(iter(voices)) if len(voices) == 1 else None,
            "rate": args.rate if args.backend == "macos" else None,
            "pathBase": "directory-containing-narration.json", "audio": "narration.wav",
            "subtitles": "captions.srt", "captions": "captions.json", "sampleRate": SAMPLE_RATE,
            "channels": 1, "format": "pcm_s16le", "sampleFrames": total_frames,
            "duration": offset / SAMPLE_RATE, "actualDuration": measured,
            "headSeconds": head_frames / SAMPLE_RATE, "gapSeconds": gap_frames / SAMPLE_RATE, "tailSeconds": tail_frames / SAMPLE_RATE,
            "segments": records, "sha256": sha256_file(combined),
            "sourcePlan": {"fileName": plan_path.name, "sha256": sha256_file(plan_path)},
            "validation": {"durationMeasuredBy": "ffprobe and PCM sample frames", "wavFormatChecked": True, "completeDecode": "passed: ffmpeg full decode", "listeningReview": "未做人工听审；不保证输入录音与spokenText逐字一致或公式读音正确。"},
        }
        if index_path:
            manifest["sourceAudioIndex"] = {"fileName": index_path.name, "sha256": sha256_file(index_path)}
        if teaching:
            manifest["teaching"] = copy.deepcopy(teaching)
            manifest["thinkingPauses"] = thinking_pauses
        (out_dir / "narration.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return {"manifest": "narration.json", "audio": "narration.wav", "captions": "captions.json", "subtitles": "captions.srt", "duration": manifest["duration"], "actualDuration": measured, "segments": len(records), "backend": args.backend, "provider": manifest["provider"]}
    finally:
        # Retain failed intermediate audio for inspection; remove only our lock.
        lock.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", help="Ling生成的plan.json")
    parser.add_argument("--out-dir", required=True, help="新的或已存在但为空的目录")
    parser.add_argument("--backend", choices=("audio", "macos"), default="audio")
    parser.add_argument("--audio-index", help="音频索引JSON；默认查找plan旁的audio-index.json")
    parser.add_argument("--voice", default="Tingting")
    parser.add_argument("--rate", type=int, default=155)
    parser.add_argument("--head", type=float, default=0.35, help="片头静音秒数")
    parser.add_argument("--gap", type=float, default=0.25, help="段间静音/字幕停留秒数")
    parser.add_argument("--tail", type=float, default=1.2, help="末尾静音/字幕停留秒数")
    parser.add_argument("--line-width", type=int, default=18, help="每行中文宽度；ASCII按半宽计")
    args = parser.parse_args(argv)
    if not 1 <= args.rate <= 1000:
        parser.error("--rate 必须在1到1000之间。")
    if not 8 <= args.line_width <= 40:
        parser.error("--line-width 必须在8到40之间。")
    if any(not math.isfinite(value) or not 0 <= value <= 60 for value in (args.head, args.gap, args.tail)):
        parser.error("--head/--gap/--tail 必须是0到60之间的有限秒数。")
    try:
        summary = prepare(args)
    except (NarrationError, OSError, wave.Error) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
