# 样本 01：五年级小数乘法 `0.3 × 0.2 = 0.06`（78s）

- 成片：[decimal-0.3x0.2-78s.mp4](decimal-0.3x0.2-78s.mp4)（1080×1920，30fps，约 77.97s，含 Ming TTS 普通话旁白、中文字幕与 6 秒思考停顿）
- 成人辅导提示：[teaching-guide.md](teaching-guide.md)
- 自检抽帧示例：`frames/`
  - `1-round0-ling-flagged-数到15格.png`（Ling 在第 0 轮标出的问题帧）
  - `2-final-0.3x0.2=0.06.png`（最终成片核心算理画面）
  - `3-final-transfer-labels-1to7.png`（迁移题 8 格缺「8」标号的漏标帧，Ling 在第 2 轮查出）
- 本轮真实运行记录：经 `structure` + `homework` + 3 轮抽帧自检（2 次修订），共 18 次调用、317,918 Ling tokens（输入 250,085 / 输出 67,833），总耗时约 29 分钟，状态 `revision-limit`（人工复核另发现第 2 轮曾误报 4 列为 3 列，且前段存在约 16 秒旁白快于画面变化）。
