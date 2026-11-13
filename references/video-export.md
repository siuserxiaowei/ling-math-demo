# 教学视频、声音与时间轴

主入口film.mjs默认输出有百灵Ming旁白、烧录字幕的1080×1920/30fps MP4及成人使用提示。新生成计划有teaching对象；旧计划允许显式导入，标legacy，不能把旧片当作已含思考题。

## 计划与成人提示

ling_plan.mjs生成schemaVersion1的严格JSON。teaching记录parent/teacher、grade、learningGoal、misconception、prerequisites、check和adultTips。check中的questionSegmentId/answerSegmentId指向相邻两段，pauseSeconds为3–15秒；question/expectedAnswer/explanation与实际段落一致。结构校验只能证明字段及引用有效，不能证明数学正确、题目有迁移价值或孩子学会。

字幕text短于两行，spokenText用自然中文数学读法，visual描述连续可见操作。检验题改变主例数据或问法，提问段不透露答案，下一段才解释。成人提示使用实际check内容，不另编题目。teaching-guide.md由同一计划生成；引导家长/老师怎样追问和暂停，成人使用建议不放进学生画面。

## 配音和真实思考时间

Ming逐段缓存声音；prepare_narration.py把音频标准化为48kHz单声道16位PCM，用实际样本测量时间。手动调用时使用doctor选择的Python命令及args，避免系统旧python3遮蔽新版本。默认film会自动选取。

每段start/end是画面区间，voiceStart/voiceEnd是实际声音区间；字幕有效区间为[voiceStart,end)。提问voiceEnd之后插入max(普通gap, pauseSeconds)的实际零样本，答案voiceStart在静音结束后。没有重复加普通gap；最后end等于整轨duration。

narration.json保留teaching与thinkingPauses[{questionSegmentId,answerSegmentId,start,end,duration,requestedSeconds}]，并绑定原plan字节SHA。film复用时核对计划、时间、字幕、分段hash和实际WAV；思考区间逐样本须为0，不接受只改hash或时间声明的带声假停顿。legacy没有声明思考期，不补造验证。

## 内部动画与检查

HTML完全离线，内联CSS/JS/SVG。lesson.duration等于narration.duration，setTime(seconds)同步确定且支持任意前后跳转；inspect只返回实际状态。没有播放器控件、自动播放、调试字段或服务调用。声音在外部合成，逐帧渲染不请求API。

字幕元素唯一#film-caption，data-segment-id准确；显示该段lines或text，不自行改字。真实字号48–60px，最多两行，左右至少64px、底至少96px安全区。主图标签约44px以上且不裁切，字幕与主图分区；思考期题目保持、答案与结果数量隐藏。

verify_film.mjs检查真实字幕、边界、安全区、SVG文字裁切及前后跳转，并采样思考期首/中/末。默认截图反馈选择主例、思考期、答案与收束，避免只看片头片尾漏掉主例数学。答案隐藏、真实数量几何和教学逻辑仍须Agent独立看图核验，不把inspect自报数据当证据。

render_video.mjs合并真实音轨，H.264/yuv420p及AAC；音频长于视频时失败，不悄悄截断。MP4完成后核对时长、音轨、实际编码帧并完整解码。响度调整应保留原声和回执、记录增益、保持时间轴，再检验实际发布文件。ASR辅助不等同人工听审或课堂试验。

## 复用SVG源与边界

compose_film.mjs可按声明的按钮动作和源时间映射运行已有lesson SVG，克隆实际图形并配实测声音。这是宿主合成，原HTML逐字保留并绑定hash；不支持任意Canvas或网页。新教学计划要求检验题和思考期，不能把老SVG换标题后假称已完成教学设计。

当前自动入口与检查器按1080×1920竖屏验收。其他画幅需同时适配生成、检查和渲染，不能只缩放后声称已经验证课堂横屏版。用户明确只要互动网页时见interactive-mode.md。
