#!/usr/bin/env python3
"""Real WAV/FFmpeg integration checks; no API, credentials, or network access."""

from __future__ import annotations

import hashlib
import argparse
import copy
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import wave

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import prepare_narration as module


def write_wave(path: Path, rate: int, channels: int, seconds: float) -> None:
    with wave.open(str(path), "wb") as dst:
        dst.setnchannels(channels)
        dst.setsampwidth(2)
        dst.setframerate(rate)
        samples = [int(5000 * math.sin(2 * math.pi * 330 * i / rate)) for i in range(round(rate * seconds))]
        dst.writeframes(b"".join(struct.pack("<h", sample) * channels for sample in samples))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg/FFprobe required")
class PrepareNarrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evidence = Path(tempfile.mkdtemp(prefix="prepare-narration-tests-", dir="/tmp"))
        print(f"Test evidence: {cls.evidence}", file=sys.stderr)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="case-", dir=self.evidence))
        self.plan_path = self.root / "plan.json"
        self.plan = {
            "schemaVersion": 1, "title": "圆的面积", "topic": "圆面积推导", "audience": "小学高年级",
            "segments": [
                {"id": "intro", "text": "圆的面积为什么是πr²？", "spokenText": "圆的面积为什么是派乘半径的平方？", "visual": {"scene": "circle", "stage": "intro", "radius": 120}},
                {"id": "preserve", "text": "只移动，不改变面积。", "spokenText": "只移动，不改变面积。", "visual": {"scene": "circle", "stage": "rearrange", "n": 16}},
            ],
        }
        self.save_plan()
        self.audio_dir = self.root / "voice"
        self.audio_dir.mkdir()
        write_wave(self.audio_dir / "one.wav", 24000, 1, .25)
        write_wave(self.audio_dir / "two.wav", 44100, 2, .4)
        self.index_path = self.audio_dir / "audio-index.json"
        self.index_path.write_text(json.dumps({
            "schemaVersion": 1, "provider": "Ming", "model": "Ming-3.0-tts-0.5B", "voice": "灵小柔",
            "segments": [{"id": "intro", "audio": "one.wav"}, {"id": "preserve", "audio": "two.wav"}],
        }, ensure_ascii=False), encoding="utf-8")

    def save_plan(self):
        self.plan_path.write_text(json.dumps(self.plan, ensure_ascii=False), encoding="utf-8")

    def add_teaching(self, seconds=4):
        self.plan["teaching"] = {
            "mode": "parent", "grade": "小学五年级", "learningGoal": "理解切拼前后面积守恒。",
            "misconception": "以为移动图形会改变面积。", "prerequisites": ["知道面积表示平面的大小。"],
            "check": {
                "questionSegmentId": "intro", "answerSegmentId": "preserve",
                "question": "只移动这些图形，总面积会变吗？", "expectedAnswer": "不会改变。",
                "explanation": "没有增加、删去或拉伸任何一块。", "pauseSeconds": seconds,
            },
            "adultTips": ["先让孩子说出自己的猜想。", "让孩子说明判断依据，再播放答案。"],
        }
        self.save_plan()

    def cli(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPTS / "prepare_narration.py"), str(self.plan_path), *map(str, args)], capture_output=True, text=True)

    def prepare(self, name="output", *args):
        target = self.root / name
        result = self.cli("--audio-index", self.index_path, "--out-dir", target, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return target, json.loads((target / "narration.json").read_text())

    def test_formula_caption_and_spoken_text_are_separate(self):
        target, narration = self.prepare()
        first = narration["segments"][0]
        self.assertEqual(first["text"], self.plan["segments"][0]["text"])
        self.assertIn("派乘半径", first["spokenText"])
        self.assertEqual(first["visual"], self.plan["segments"][0]["visual"])
        self.assertEqual((first["provider"], first["model"], first["voice"]), ("Ming", "Ming-3.0-tts-0.5B", "灵小柔"))
        srt = (target / "captions.srt").read_text()
        self.assertIn("πr²", srt)
        self.assertNotIn("派乘半径", srt)
        self.assertEqual(first["sourceSha256"], hashlib.sha256((self.audio_dir / "one.wav").read_bytes()).hexdigest())

    def test_sample_timeline_padding_and_pcm_match_ffprobe(self):
        target, narration = self.prepare("timing", "--head", ".2", "--gap", ".3", "--tail", ".4")
        first, second = narration["segments"]
        self.assertEqual(first["start"], 0)
        self.assertEqual(first["voiceStart"], .2)
        self.assertAlmostEqual(first["end"] - first["voiceEnd"], .3)
        self.assertEqual(second["start"], first["end"])
        self.assertEqual(second["voiceStart"], second["start"])
        self.assertEqual(second["end"], narration["duration"])
        self.assertAlmostEqual(second["end"] - second["voiceEnd"], .4)
        self.assertAlmostEqual(narration["actualDuration"], narration["duration"], delta=1 / 48000)
        with wave.open(str(target / "narration.wav"), "rb") as audio:
            self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth()), (48000, 1, 2))
            self.assertEqual(audio.getnframes(), narration["sampleFrames"])
            for start, length in [(0, .2), (first["voiceEnd"], .3), (second["voiceEnd"], .4)]:
                audio.setpos(round(start * 48000))
                self.assertEqual(set(audio.readframes(round(length * 48000))), {0})
        captions = json.loads((target / "captions.json").read_text())
        self.assertLessEqual(captions["cues"][0]["end"], captions["cues"][1]["start"])
        self.assertEqual(captions["cues"][0]["start"], first["voiceStart"])
        self.assertEqual(captions["cues"][-1]["end"], narration["duration"])
        for item in narration["segments"]:
            self.assertLessEqual(item["start"], item["voiceStart"])
            self.assertLess(item["voiceStart"], item["voiceEnd"])
            self.assertLessEqual(item["voiceEnd"], item["end"])
            self.assertEqual(module.check_pcm(target / item["audio"]), item["sampleFrames"])
        self.assertEqual(narration["sha256"], hashlib.sha256((target / "narration.wav").read_bytes()).hexdigest())

    def test_thinking_pause_is_real_silence_and_answer_starts_after_it(self):
        # Fractional seconds exercise ceil-to-sample behaviour: the actual
        # thinking interval must never be shorter than the requested pause.
        requested = 3.00001
        self.add_teaching(requested)
        target, narration = self.prepare("thinking", "--head", ".2", "--gap", ".3", "--tail", ".4")
        question, answer = narration["segments"]
        pause = narration["thinkingPauses"][0]
        frames = math.ceil(requested * 48000)
        self.assertEqual(narration["teaching"], self.plan["teaching"])
        self.assertEqual((pause["questionSegmentId"], pause["answerSegmentId"]), ("intro", "preserve"))
        self.assertEqual(pause["start"], question["voiceEnd"])
        self.assertEqual(pause["end"], answer["voiceStart"])
        self.assertEqual(question["end"], answer["start"])
        self.assertGreaterEqual(pause["duration"], requested)
        self.assertEqual(pause["duration"], frames / 48000)
        self.assertEqual(question["pauseAfter"], frames / 48000)
        self.assertAlmostEqual(answer["end"] - answer["voiceEnd"], .4)
        captions = json.loads((target / "captions.json").read_text())
        self.assertEqual(captions["cues"][0]["end"], answer["voiceStart"])
        self.assertEqual(captions["cues"][1]["start"], answer["voiceStart"])
        with wave.open(str(target / "narration.wav"), "rb") as audio:
            audio.setpos(round(pause["start"] * 48000))
            self.assertEqual(audio.readframes(frames), b"\x00\x00" * frames)
            self.assertTrue(any(audio.readframes(4800)), "the actual answer audio follows the silent interval")
        self.assertEqual(narration["sourcePlan"]["sha256"], hashlib.sha256(self.plan_path.read_bytes()).hexdigest())

    def test_thinking_pause_replaces_gap_instead_of_adding_it(self):
        self.add_teaching(3)
        _, narration = self.prepare("longer-normal-gap", "--gap", "5.25")
        first = narration["segments"][0]
        self.assertEqual(first["pauseAfter"], 5.25)
        self.assertEqual(narration["thinkingPauses"][0]["duration"], 5.25)
        self.assertEqual(narration["thinkingPauses"][0]["requestedSeconds"], 3)

    def test_legacy_plan_does_not_gain_teaching_metadata_or_extra_silence(self):
        _, narration = self.prepare("legacy")
        self.assertNotIn("teaching", narration)
        self.assertNotIn("thinkingPauses", narration)
        self.assertEqual(narration["segments"][0]["pauseAfter"], .25)

    def test_invalid_teaching_is_rejected_before_tts_or_media_writes(self):
        self.add_teaching()
        valid = copy.deepcopy(self.plan)
        invalid = [
            lambda p: p.update(teaching=None),
            lambda p: p["teaching"].update(mode="child"),
            lambda p: p["teaching"].update(adultTips=["只一条"]),
            lambda p: p["teaching"].update(prerequisites=[False]),
            lambda p: p["teaching"].update(check=[]),
            lambda p: p["teaching"]["check"].update(pauseSeconds=True),
            lambda p: p["teaching"]["check"].update(pauseSeconds=2.99),
            lambda p: p["teaching"]["check"].update(pauseSeconds=15.01),
            lambda p: p["teaching"]["check"].update(questionSegmentId="missing"),
            lambda p: p["teaching"]["check"].update(answerSegmentId="intro"),
            lambda p: p["teaching"]["check"].update(questionSegmentId="preserve", answerSegmentId="intro"),
            lambda p: p["teaching"]["check"].update(unrecognized="not accepted"),
        ]
        for number, mutate in enumerate(invalid):
            with self.subTest(number=number):
                self.plan = copy.deepcopy(valid)
                mutate(self.plan)
                self.save_plan()
                target = self.root / f"invalid-teaching-{number}"
                args = argparse.Namespace(plan=self.plan_path, out_dir=target, line_width=18, backend="macos")
                with mock.patch.object(module, "run") as runner, mock.patch.object(module, "installed_voice") as voice:
                    with self.assertRaises(module.NarrationError):
                        module.prepare(args)
                    runner.assert_not_called()
                    voice.assert_not_called()
                self.assertFalse(target.exists())

        self.plan = copy.deepcopy(valid)
        self.plan["segments"].append({**self.plan["segments"][1], "id": "later-answer"})
        self.plan["teaching"]["check"]["answerSegmentId"] = "later-answer"
        self.save_plan()
        target = self.root / "non-adjacent"
        result = self.cli("--audio-index", self.index_path, "--out-dir", target)
        self.assertEqual(result.returncode, 1)
        self.assertIn("紧接问题段", result.stderr)
        self.assertFalse(target.exists())

    def test_nonempty_directory_is_untouched(self):
        target = self.root / "occupied"
        target.mkdir()
        sentinel = target / "important.txt"
        sentinel.write_text("keep")
        result = self.cli("--audio-index", self.index_path, "--out-dir", target)
        self.assertEqual(result.returncode, 1)
        self.assertIn("拒绝覆盖", result.stderr)
        self.assertEqual(list(target.iterdir()), [sentinel])
        self.assertEqual(sentinel.read_text(), "keep")

    def test_long_caption_fails_without_fabricating_cues(self):
        self.plan["segments"][0]["text"] = "这是一个特别长的字幕句子。" * 5
        self.save_plan()
        target = self.root / "long"
        result = self.cli("--audio-index", self.index_path, "--out-dir", target)
        self.assertEqual(result.returncode, 1)
        self.assertIn("不会均摊", result.stderr)
        self.assertFalse(target.exists())

    def test_formula_in_spoken_text_is_rejected(self):
        self.plan["segments"][0]["spokenText"] = "面积等于πr²"
        self.save_plan()
        target = self.root / "formula"
        result = self.cli("--audio-index", self.index_path, "--out-dir", target)
        self.assertEqual(result.returncode, 1)
        self.assertIn("中文读法", result.stderr)
        self.assertFalse(target.exists())

    def test_caption_width_uses_ascii_halfwidth_and_punctuation(self):
        lines = module.caption_lines("圆面积=πr²。长越来越接近半个圆周，宽越来越接近半径。", 18)
        self.assertLessEqual(len(lines), 2)
        self.assertTrue(all(module.half_width(line) <= 36 for line in lines))
        self.assertEqual(module.half_width("ABCabc"), module.half_width("圆面积"))

    def test_companion_index_and_numeric_ids(self):
        for number, item in enumerate(self.plan["segments"], 1):
            item["id"] = number
        self.save_plan()
        (self.root / "audio-index.json").write_text(json.dumps({"schemaVersion": 1, "segments": [{"id": 1, "audio": "voice/one.wav"}, {"id": 2, "audio": "voice/two.wav"}]}))
        target = self.root / "companion"
        result = self.cli("--out-dir", target)
        self.assertEqual(result.returncode, 0, result.stderr)
        narration = json.loads((target / "narration.json").read_text())
        self.assertEqual([item["id"] for item in narration["segments"]], ["1", "2"])
        self.assertTrue(all(not Path(item["audio"]).is_absolute() for item in narration["segments"]))

    def test_explicit_wav_overrides_stale_index_without_wrong_voice_attribution(self):
        for number, item in enumerate(self.plan["segments"]):
            item["audio"] = "voice/one.wav" if number == 0 else "voice/two.wav"
            item["audioSource"] = {"provider": "user-recording", "voice": "创作者录音"}
        self.save_plan()
        data = json.loads(self.index_path.read_text())
        for item in data["segments"]:
            item["audio"] = "stale-file.wav"
        self.index_path.write_text(json.dumps(data, ensure_ascii=False))
        _, narration = self.prepare("explicit")
        self.assertEqual(narration["provider"], "user-recording")
        self.assertEqual(narration["voice"], "创作者录音")
        self.assertIsNone(narration["model"])

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("say"), "real local say requires macOS")
    def test_real_macos_two_segment_smoke(self):
        self.plan["segments"][0].update(text="看这个圆。", spokenText="看这个圆。")
        self.plan["segments"][1].update(text="面积不变。", spokenText="面积不变。")
        self.save_plan()
        target = self.root / "real-say"
        result = self.cli("--backend", "macos", "--out-dir", target)
        self.assertEqual(result.returncode, 0, result.stderr)
        narration = json.loads((target / "narration.json").read_text())
        self.assertEqual(narration["provider"], "macos-say")
        self.assertEqual(narration["voice"], "Tingting")
        self.assertGreater(narration["segments"][0]["sourceDuration"], 0)
        self.assertEqual(narration["segments"][-1]["end"], narration["duration"])
        self.assertEqual(narration["validation"]["completeDecode"], "passed: ffmpeg full decode")


if __name__ == "__main__":
    unittest.main(verbosity=2)
