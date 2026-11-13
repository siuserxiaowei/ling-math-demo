# 配音与导入

主创模型始终是Ling-3.2-flash，语音合成单独记录。

- 默认`--tts auto`与显式`--tts ming`均使用百灵官方Ming TTS API，所有平台一致。官方`https://api.ant-ling.com/v1/audio/speech`，默认请求Ming-3.0-tts-0.5B/UK_Charlotte。只复用官方Ling私有配置的token，不把第三方平台token发到Ant。费用、权限、音色以官方实际说明为准，首次真实短样音后再批量。二进制响应无model字段时仅记录请求模型，不编造已验证响应模型。
- 用户显式选择`--tts macos`时，macOS已有普通话Tingting可本地say配音，默认rate155；无联网语音请求，来源macos-say。首次检查实际音色存在。其他平台不能伪装这个后端，API失败也不会自动切换到它。
- 导入：用户显式选择`--tts import`时，audio-index.json包含segments[{id,audio,provider,model,voice,receipt}]，audio相对索引目录。没有可认证回执时明确标导入、服务来源未验证。可由用户已配置的TTS工具提供逐段WAV，不能只填一个Ming名字就宣称是Ming声音。

```bash
node scripts/ming_speech.mjs --text-file s01.txt --output voice/s01.wav
# 使用doctor选出的Python命令及前缀参数运行：
prepare_narration.py plan.json --audio-index voice/audio-index.json --out-dir narration
```

官方协议核验2026-11-08：[TTS文档](https://developer.ant-ling.com/zh-CN/docs/api-reference/audio/tts/)。本轮真实控制组与教学短句已取得有效声音：使用官方示例UK_Charlotte，`response_format: pcm`、`stream_format: sse`，默认不发送sample_rate/speed。原灵小柔加显式可选参数的组合返回空done；单变量中文声线对照也能产生声音，因此不能把空流归因于音色本身。中文声线对照转录不稳定，当前默认保留已核验的UK_Charlotte。ASR不等同人工听审；长轨转录有误时可按实际逐段文件核对，保留原结果。

收到完整、非空PCM后无损加WAV容器，以官方默认44100Hz及兼容PCM约定作16bit小端单声道解释，记录依据并FFprobe/转录核对。PCM可能自然以FF FF等字节开头，不能凭两字节误判MP3；仅完整连续的合法MPEG帧可确立压缩流。已通过真实失败回执与重试相同原音频SHA复现并修复此问题。成功和解析失败均保留原响应payload及hash，便于本地重检而不反复请求。

空体/只有done但无delta/损坏音频明确失败，不补假头或伪造成功；401/403/429停止，不切账号、模型或后端绕过。响应未回显model时保留modelVerified=false；token usage为0也不推断免费。

短样音与正式音轨需核对内容和音量。渲染时只读取缓存音频，不实时调用语音服务。服务失败不得交付无声片冒充完成；本地音色或其他声音来源由实际选择明确标注。

成片声音偏小时，先测实际响度与真峰值，再按峰值余量加固定增益；保留原Ming声音和回执，记录增益。可复制视频流、只重编码音频，补齐视频末尾静音并核对声画时长；不拉伸或截断旁白。验证处理后的MP4并看实际帧，不用原声检查冒充后处理验收。
