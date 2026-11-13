# 明确要求互动网页时

只有用户明确要可拖动、可切例题的网页，才使用旧互动入口：

```bash
node scripts/demo.mjs --prompt '把圆面积做成能拖动的演示' --out-dir output/new-demo
node scripts/serve_lesson.mjs --dir output/new-demo
```

默认Ling真实生成并做一轮实际截图反馈，运行与内容核验后打开页面。离线HTML用window.lesson.duration/setTime/inspect及?video=1。`--video`导出的只是无声诊断预览；用户要旁白字幕时回到film主入口。

圆面积和分数除法本地基准用于数学回归，不能代替模型成绩。真实Ling分数除法源与来源见verified-fraction-case.md；本地基准assets/lesson.html与真实Ling源assets/fraction-division-ling.html分别标注。
