# 原生多模态 v0.5.0

在Skill目录运行。默认all依次识别参考结构和作业，套入用户题目生成新计划、新画面、新Ming声音，再自动截图审核与修订。可用--mode structure或homework单独选择输入入口，两者都在成片后审核。

```bash
# 看爆款学结构：学习节奏，套到自己的题
node scripts/run_multimodal_demo.mjs --mode structure --ref-video /绝对路径/参考.mp4 --prompt '给五年级讲分数除法' --out-dir outputs/structure-new
# 拍错题出视频：识别错误并驱动teaching.misconception
node scripts/run_multimodal_demo.mjs --mode homework --photo /绝对路径/作业.png --prompt '解释孩子的错法' --out-dir outputs/homework-new
# 一条命令跑三个入口，并自动看成片挑错，最多修订2次
node scripts/run_multimodal_demo.mjs --max-rounds 2
# 无Key演练，绝不调用API
node scripts/run_multimodal_demo.mjs --dry-run
```

默认outputs/mm-日期/，离线目录有-dry-run后缀。要求新目录避免覆盖。演练素材由本地Python/Pillow和ffmpeg生成，图片明确标“模拟素材”；视频是9秒本地合成的画面变化，不冒称真实爆款。可用--video指定自行裁剪的有权素材；无参数时真实调用也使用模拟输入测试整条链路。

直接审核已有成片可导入multimodal.mjs的reviewLoop，提供video、html、narration（实测segments时间轴）、audio、outDir、maxRounds及render回调；默认演练脚本已连接render_video.mjs。每段声音中点和停顿中点截PNG，按4张一批发送对应spokenText；审核结果为passed/issues/revision，未通过则将修订、原HTML和固定时间轴反馈给同一Ling，重新渲染并再次审核。maxRounds为修订次数，初次审核另计；达到上限标revision-limit，命令退出码2，不宣称通过。每轮保留frames、各批response.md、receipt.json、review.json和修订HTML/MP4。最终视频路径以run.json的review.video为准。

作业看不清停止；误区必须逐字进入新计划teaching.misconception，否则现有计划重试机制要求Ling重做。模型回复字段不合法停止并保留原文。结构模板仅作为节奏数据，不把原视频或其音轨送进生成/渲染环节。真实执行仍需人工复核教学、数学、音轨及未抽样画面。

官方字段于2026-11-12打开核对：[OpenAI兼容接口](https://developer.ant-ling.com/zh-CN/docs/api-reference/chat/openai)、[多模态理解](https://developer.ant-ling.com/zh-CN/docs/tutorials/multimodal-understanding)。视频内容块为`{type:"video_url",video_url:{url:"data:video/mp4;base64,..."}}`；MOV为video/quicktime，WMV为video/x-ms-wmv。服务端固定2fps最多32帧，可能遗漏短暂变化。图片仅JPEG/PNG，≤40张、像素面积≤16384×784；媒体Base64与总请求≤32MiB，编码开销可能使原文件不到32MiB仍被拒绝。视频≤30秒且每请求1段；不支持公网URL，传本地路径。

```bash
ffmpeg -i input.mp4 -t 30 -vf scale=640:-2 -c:v libx264 -crf 28 output.mp4
```

复用ling_client的配置读取、密钥脱敏、网关一次重试和429立即停止；不记录请求Base64或密钥。dry-run仅构造、校验请求和抽帧，输出摘要；不生成假模型回复或伪造新教学成片。Python/Pillow只用于合成演练素材，ffprobe/ffmpeg用于本地媒体校验和截图。

补充规格：`--ref-video`（兼容旧 `--video`）保存结构分析为输出根目录 `structure.json`，观察开头抛错、图形演示、节奏分段与结尾留题，缺失环节如实标注。每次审核抽6–10帧并保存完整旁白时间轴，`--max-rounds 2` 表示最多2次修订、3轮审核；参数范围0–2。测试图标注「测试图，非真实作业」。
