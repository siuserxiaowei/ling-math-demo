# v0.2.0 分数除法历史成片

本例已交付约60秒、1080×1920、30fps的有声MP4，包含普通话旁白与烧录中文字幕。覆盖`3/4÷1/2=1又1/2`和`2/3÷1/6=4`，解释完整组、余量和余量占每组的比例。

## 来源与真实修改

`assets/fraction-division-ling.html`是官方Ling-3.2-flash生成并经历4次真实截图反馈修订的原始课件；HTML逐字保留，SHA与来源见同名provenance.json。它是内部图形来源，默认交付仍为视频。

视频分镜经真实Ling生成和修订。`assets/fraction-film-plan.json`是其制作副本：宿主只删去s14朗读稿里带内部A/B标签的重复回顾，保留一般规则；完整前后文本见`fraction-film.provenance.json`。最后一次模型微调遇HTTP429后停止请求，复用既有真实材料完成本地制作。没有把宿主合成HTML说成新一次Ling输出。

`assets/fraction-film-map.json`声明逐段源课件时间与按钮动作。s14实际收束于第一个例子的末态，未实现原分镜的A+B并列；旁白为通用规则，此项作为宿主执行覆盖记录。

制作v0.2.0分数除法时，Ming旧调用返回HTTP200、audio/wav但音频为空，历史成片实际旁白为系统Tingting。v0.3.0已按官方PCM/SSE示例跑通Ming教学配音，默认改为Ming API；三个新增案例见verified-teaching-cases.md。不要把旧片的Tingting改标签说成Ming。

## 验证范围

逐段14处画面中点核对数学与图形，59处中点/字幕边界技术检查通过；实际编码MP4抽帧确认字幕烧入画面。FFprobe确认AAC音轨与声画时长，完整解码通过。三段连续PCM转录覆盖全片，与朗读稿核对分数读法；保留ASR同音误识，未冒充人工听审。未验证课堂学习效果，也不证明其他知识点一次成功。

原课件A用四分之一为共同单位，3格被除数、2格一组，得到一整组加半组；B用六分之一为共同单位，4格被除数、1格一组，得到4整组、无余量。图形长度实际测量，未把第三行组图与第四行比例图重复加总。

## 无新API重制本例

先用`prepare_narration.py assets/fraction-film-plan.json --backend macos --voice Tingting --out-dir OUTPUT/narration`配音，再用`compose_film.mjs --source-html assets/fraction-division-ling.html --narration OUTPUT/narration/narration.json --map assets/fraction-film-map.json --output OUTPUT/composed/video.html`合成。最后执行`film.mjs --prompt '重制已验证的分数除法案例' --out-dir OUTPUT/final --html OUTPUT/composed/video.html --plan assets/fraction-film-plan.json --narration OUTPUT/narration/narration.json`验证和渲染。脚本均在scripts目录，输出使用新的绝对路径。

这是已验证素材的本地复用，新知识点仍走Ling API流程，不能换标题冒充新生成。
