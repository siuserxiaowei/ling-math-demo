#!/usr/bin/env python3
"""Build measured Chinese narration from macOS say or supplied WAV segments.

Input: {"segments": [{"text": "朗读稿", "audio": "optional.wav"}]}.
Source audio is resolved relative to the input JSON. Every output audio path is
relative to the generated narration.json, which lives inside --out-dir.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import wave


SAMPLE_RATE = 48_000
FORMULA_SYMBOLS = re.compile(r"[πΠ=×÷²³√∑∫^*/+<>≤≥−]")
SINGLE_LETTER = re.compile(r"(?<![A-Za-z])[A-Za-z](?![A-Za-z])")


class NarrationError(Exception):
    """An actionable input, runtime, or media error."""


def run(command: list[str], *, timeout: float = 300) -> str:
    try:
        result = subprocess.run(
            command, check=True, capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        raise NarrationError(f"找不到命令：{command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise NarrationError(f"命令执行超时：{Path(command[0]).name}") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "无详细错误").strip()[-2_000:]
        raise NarrationError(f"{Path(command[0]).name} 执行失败：{detail}") from exc
    return result.stdout


def read_spec(path: Path) -> tuple[dict, list[dict]]:
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise NarrationError(f"无法读取输入 JSON：{exc}") from exc
    if not isinstance(spec, dict):
        raise NarrationError("输入 JSON 必须是包含 segments 数组的对象。")
    raw_segments = spec.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise NarrationError("segments 必须是至少包含一段旁白的数组。")
    segments = []
    for index, raw in enumerate(raw_segments, 1):
        if not isinstance(raw, dict) or not isinstance(raw.get("text"), str):
            raise NarrationError(f"第 {index} 段必须包含字符串 text。")
        original = raw["text"].strip()
        spoken = raw.get("spokenText", original)
        if not isinstance(spoken, str) or not spoken.strip() or not original:
            raise NarrationError(f"第 {index} 段的 text/spokenText 不能为空。")
        spoken = spoken.strip()
        if FORMULA_SYMBOLS.search(spoken) or SINGLE_LETTER.search(spoken):
            raise NarrationError(
                f"第 {index} 段含公式或变量符号。请把朗读稿写成中文，"
                "例如把 πr² 写成‘派乘半径的平方’；也可另填 spokenText，"
                "原 text 会保存在 sourceText。"
            )
        source_audio = raw.get("audio")
        resolved = None
        if source_audio is not None:
            if not isinstance(source_audio, str) or not source_audio.strip():
                raise NarrationError(f"第 {index} 段 audio 必须是 WAV 文件路径。")
            candidate = Path(source_audio).expanduser()
            resolved = (path.parent / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
            if resolved.suffix.lower() != ".wav" or not resolved.is_file():
                raise NarrationError(f"第 {index} 段音频不存在或不是 .wav 文件。")
        segments.append({"sourceText": original, "text": spoken, "sourceAudio": resolved})
    return spec, segments


def installed_voice(say: str, voice: str) -> None:
    voices = set()
    for line in run([say, "-v", "?"]).splitlines():
        match = re.match(r"^(.*?)\s+[a-z]{2}_[A-Z]{2}\s+#", line)
        if match:
            voices.add(match.group(1).strip())
    if voice not in voices:
        raise NarrationError(
            f"本机未安装音色 {voice!r}。请用 say -v '?' 查看已有音色，"
            "通过 --voice 选择；脚本不会自动下载音色。"
        )


def probe_duration(ffprobe: str, path: Path) -> float:
    value = run([
        ffprobe, "-v", "error", "-show_entries", "format=duration", "-of",
        "default=noprint_wrappers=1:nokey=1", str(path),
    ]).strip()
    try:
        duration = float(value)
    except ValueError as exc:
        raise NarrationError(f"ffprobe 没有返回有效音频时长：{path.name}") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise NarrationError(f"音频时长无效：{path.name}")
    return duration


def check_pcm(path: Path) -> int:
    try:
        with wave.open(str(path), "rb") as src:
            if (src.getnchannels(), src.getsampwidth(), src.getframerate(), src.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
                raise NarrationError(f"WAV 规格错误：{path.name}，应为48kHz单声道PCM16。")
            if src.getnframes() <= 0:
                raise NarrationError(f"WAV 文件没有音频帧：{path.name}")
            return src.getnframes()
    except (OSError, EOFError, wave.Error) as exc:
        raise NarrationError(f"无法读取 WAV：{path.name}：{exc}") from exc


def timestamp(seconds: float) -> str:
    value = round(seconds * 1000)
    hours, value = divmod(value, 3_600_000)
    minutes, value = divmod(value, 60_000)
    whole_seconds, millis = divmod(value, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{millis:03d}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1_048_576), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make(args: argparse.Namespace) -> dict:
    source = Path(args.input).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    if out_dir.exists() and (not out_dir.is_dir() or any(out_dir.iterdir())):
        raise NarrationError("输出目录已存在且非空，拒绝覆盖。请使用新的空目录。")
    spec, inputs = read_spec(source)
    needs_say = any(item["sourceAudio"] is None for item in inputs)
    say = None
    if needs_say:
        if sys.platform != "darwin":
            raise NarrationError(
                "当前系统没有 macOS say。请为每段提供 audio WAV 路径"
                "（相对输入 JSON），脚本仍可合并、测时并生成字幕。"
            )
        say = shutil.which("say")
        if say is None:
            raise NarrationError("未找到 macOS say；也可为每段提供 audio WAV。")
        installed_voice(say, args.voice)
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise NarrationError("PATH 中需要 FFmpeg 和 FFprobe；脚本不会自动安装依赖。")
    out_dir.mkdir(parents=True, exist_ok=True)
    lock = out_dir / ".make-narration.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise NarrationError("输出目录正被另一进程使用。") from exc
    os.close(descriptor)
    try:
        records = []
        with tempfile.TemporaryDirectory(prefix="math-narration-") as scratch:
            for index, item in enumerate(inputs, 1):
                imported = item["sourceAudio"] is not None
                audio_input = item["sourceAudio"]
                if not imported:
                    audio_input = Path(scratch) / f"segment-{index:02d}.aiff"
                    # Pass text through a file, so leading '-' is never interpreted as a say option.
                    script = Path(scratch) / f"segment-{index:02d}.txt"
                    script.write_text(item["text"], encoding="utf-8")
                    run([say, "-v", args.voice, "-r", str(args.rate), "-o", str(audio_input), "-f", str(script)])
                output = out_dir / f"segment-{index:02d}.wav"
                run([
                    ffmpeg, "-n", "-v", "error", "-i", str(audio_input), "-map", "0:a:0", "-vn",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=7", "-ar", str(SAMPLE_RATE), "-ac", "1",
                    "-c:a", "pcm_s16le", str(output),
                ])
                frame_count = check_pcm(output)
                duration = probe_duration(ffprobe, output)
                if abs(duration - frame_count / SAMPLE_RATE) > 1 / SAMPLE_RATE:
                    raise NarrationError(f"音频帧数与测得时长不符：{output.name}")
                record = {
                    "id": index, "text": item["text"], "audio": output.name,
                    "actualDuration": duration, "provider": "imported-wav" if imported else "macos-say",
                    "voice": None if imported else args.voice, "rate": None if imported else args.rate,
                }
                if item["sourceText"] != item["text"]:
                    record["sourceText"] = item["sourceText"]
                records.append(record)

        combined = out_dir / "narration.wav"
        pause_frames = round(args.pause * SAMPLE_RATE)
        offset = 0
        with wave.open(str(combined), "wb") as dst:
            dst.setnchannels(1)
            dst.setsampwidth(2)
            dst.setframerate(SAMPLE_RATE)
            for index, item in enumerate(records):
                item["start"] = offset / SAMPLE_RATE
                with wave.open(str(out_dir / item["audio"]), "rb") as src:
                    count = src.getnframes()
                    # Copy in chunks rather than loading a supplied long WAV into memory.
                    while True:
                        chunk = src.readframes(SAMPLE_RATE)
                        if not chunk:
                            break
                        dst.writeframesraw(chunk)
                offset += count
                item["end"] = offset / SAMPLE_RATE
                item["pauseAfter"] = pause_frames / SAMPLE_RATE if index < len(records) - 1 else 0
                if item["pauseAfter"]:
                    dst.writeframesraw(b"\x00\x00" * pause_frames)
                    offset += pause_frames
            dst.writeframes(b"")
        total_frames = check_pcm(combined)
        actual_duration = probe_duration(ffprobe, combined)
        if total_frames != offset or abs(actual_duration - offset / SAMPLE_RATE) > 1 / SAMPLE_RATE:
            raise NarrationError("合并后的实际时长与逐段时间轴不一致。")
        run([ffmpeg, "-v", "error", "-i", str(combined), "-f", "null", "-"])
        subtitles = out_dir / "narration.srt"
        cues = []
        for item in records:
            caption = "\n".join(textwrap.wrap(item["text"], width=22, break_long_words=True, break_on_hyphens=False))
            cues.append(f"{item['id']}\n{timestamp(item['start'])} --> {timestamp(item['end'])}\n{caption}\n")
        subtitles.write_text("\n".join(cues), encoding="utf-8")
        providers = {item["provider"] for item in records}
        manifest = {
            "schemaVersion": 1,
            "topic": spec.get("topic", "数学可视化讲解"), "audience": spec.get("audience", "学生"),
            "provenance": spec.get("provenance", "输入文稿的本地旁白合成或已有录音合并；不代表指定模型的生成结果。"),
            "provider": next(iter(providers)) if len(providers) == 1 else "mixed",
            "voice": args.voice if needs_say else None, "rate": args.rate if needs_say else None,
            "sampleRate": SAMPLE_RATE, "channels": 1, "format": "pcm_s16le",
            "pathBase": "directory-containing-narration.json",
            "audio": combined.name, "subtitles": subtitles.name,
            "actualDuration": actual_duration, "pauseBetweenSegments": pause_frames / SAMPLE_RATE,
            "segments": records,
            "pronunciationNotes": spec.get("pronunciationNotes", ["公式须另写中文朗读稿；例如π读作‘派’。"]),
            "validation": {
                "voiceInstalled": True if needs_say else None, "durationMeasuredBy": "ffprobe",
                "wavFormatChecked": True, "completeDecode": "passed: ffmpeg full decode",
                "listeningReview": "未做人工听审；文本和解码检查不能证明发音与讲解完全正确。",
            },
            "limitations": ["系统合成音可能有机械停顿；发布前需听审，替换录音后重新测时。"],
            "sha256": sha256_file(combined),
        }
        (out_dir / "narration.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return {"manifest": "narration.json", "audio": combined.name, "subtitles": subtitles.name, "actualDuration": actual_duration, "segments": len(records)}
    finally:
        # Only remove the lock created by this invocation; keep partial audio on failure.
        lock.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="含 segments 数组的输入 JSON")
    parser.add_argument("--out-dir", required=True, help="新的或已存在但为空的输出目录")
    parser.add_argument("--voice", default="Tingting", help="已安装的 macOS say 音色（默认Tingting）")
    parser.add_argument("--rate", type=int, default=155, help="macOS say 语速（默认155）")
    parser.add_argument("--pause", type=float, default=0.25, help="段间静音秒数（默认0.25）")
    args = parser.parse_args(argv)
    if not 1 <= args.rate <= 1000:
        parser.error("--rate 必须在1到1000之间。")
    if not math.isfinite(args.pause) or not 0 <= args.pause <= 10:
        parser.error("--pause 必须是0到10之间的有限秒数。")
    try:
        summary = make(args)
    except (NarrationError, OSError, wave.Error) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
