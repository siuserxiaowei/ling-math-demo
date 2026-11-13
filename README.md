# ling-math-demo (v0.5.0)

面向家长辅导与老师备课的数学可视化讲解视频 Skill：把一句小学/初中知识点需求，交给 **Ling-3.2-flash** 生成教学分镜与离线 HTML/SVG 动画，用 **百灵 Ming TTS API** 逐段配音并插入真实思考停顿，最终渲染为 1080×1920 竖屏带中文字幕的 MP4 与成人使用提示（`teaching-guide.md`）。

v0.5.0 新增两条原生多模态输入与一条渲染后自检链路：
1. **看视频学结构（`--mode structure`）**：提取 ≤30 秒参考视频的讲解节奏结构到 `structure.json`（只学节奏结构，不复用原视频画面、文案或音轨）。
2. **看错题图诊断（`--mode homework`）**：识别作业照片中的具体错因并写入 `teaching.misconception`。
3. **成片抽帧自检（`reviewLoop`）**：成片后按配音时间轴抽 6–10 帧 PNG（每批最多 4 张），连同完整旁白时间轴交由 Ling 核对画面与旁白是否一致，不通过则携带修订意见重渲染（`--max-rounds 2` 最多 2 次修订 / 3 轮审核）。

> 本仓库为代码与实操参考版本，不包含任何 API Key 或个人数据。

## 环境依赖

- Node.js >= 22
- Python >= 3.10（用于部分旁白与测试脚本）
- Playwright + Chromium（`npm install && npx playwright install chromium`）
- FFmpeg（需支持 `libx264`）与 `ffprobe`
- 百灵 API Key（仅从环境变量 `LING_API_KEY` 或 `~/.config/ling-math-demo/ling.json` 读取，不进入仓库）

## 快速开始

```bash
# 1. 安装依赖与浏览器
npm install
npx playwright install chromium

# 2. 体检本地环境与配置（不调用模型）
node scripts/doctor.mjs

# 3. 交互式写入私有 Key（隐藏输入，保存到 ~/.config/ling-math-demo/ling.json）
node scripts/configure.mjs

# 4. 离线演练（校验请求构造与本地抽帧，不调用外部 API）
node scripts/run_multimodal_demo.mjs --dry-run
```

## 常用命令

```bash
# 单句生成完整讲解视频（v0.4 主流程）
node scripts/film.mjs \
  --prompt '给五年级孩子解释0.3乘0.2为什么是0.06，他总算成0.6；用一百格演示，最后出一道类似题让他先想再看答案' \
  --out-dir output/decimal-lesson

# v0.5 多模态全流程（参考视频学结构 + 错题图识别 + 成片抽帧自检）
node scripts/run_multimodal_demo.mjs \
  --ref-video /绝对路径/参考.mp4 \
  --photo /绝对路径/作业.png \
  --prompt '给五年级讲小数乘法' \
  --max-rounds 2 \
  --out-dir output/mm-lesson
```

更多说明见：
- [SKILL.md](SKILL.md)：完整工作流与验收标准
- [references/multimodal.md](references/multimodal.md)：v0.5.0 多模态接口契约与参数说明
- [references/ling-workflow.md](references/ling-workflow.md)：Ling API 请求与安全规范
- [references/workbuddy.md](references/workbuddy.md)：放入 `.codebuddy/skills/ling-math-demo/` 的本地目录结构参考

## 实测边界记录（2026-11-12 单题实跑）

以下为 `0.3 × 0.2 = 0.6` 样本在真实链路上的客观记录，供参考：
- **视频直传兼容性**：向 `Ling-3.2-flash` 传入 `video_url`（base64 data URL）时服务端曾返回 HTTP 500（`torchvision.io` 缺少 `read_video`），当前脚本已内置回退逻辑：自动按 1fps 抽帧为 PNG 图片列表继续分析。
- **自检与开销**：完整跑通 3 轮自检（含 2 次修订）共触发 **18 次 Ling/Ming 调用、消耗 317,918 Ling tokens（输入 250,085 / 输出 67,833）、耗时约 29 分钟**；该次在达到修订上限（`revision-limit`，退出码 `2`）后停止，仍存在自检误报、漏报音画滞后等问题，成片需人工复核。

## 目录结构

- `SKILL.md`：Skill 主说明文档
- `agents/openai.yaml`：Agent 元信息
- `scripts/`：核心执行脚本与单测（`doctor.mjs`、`configure.mjs`、`film.mjs`、`run_multimodal_demo.mjs`、`multimodal.mjs`、`ling_client.mjs`、`ming_speech.mjs` 等）
- `references/`：接口规范、多模态流程、验证标准参考文档
- `assets/`：示例 HTML/JSON 教学素材
- `tests/`：Python 单测

## License

[MIT](LICENSE)

## 已生成的实测成片样本

- [样本 00：五年级小数乘法 `0.3 × 0.2 = 0.06`（v0.4 基线 65s）](samples/00-decimal-0.3x0.2-v04-65s/README.md) · [直接下载 MP4（Release v0.5.0）](https://github.com/siuserxiaowei/ling-math-demo/releases/download/v0.5.0/decimal-0.3x0.2-v04-65s.mp4)
- [样本 01：五年级小数乘法 `0.3 × 0.2 = 0.06`（78s）](samples/01-decimal-0.3x0.2/README.md) · [直接下载 MP4（Release v0.5.0）](https://github.com/siuserxiaowei/ling-math-demo/releases/download/v0.5.0/decimal-0.3x0.2-78s.mp4)
