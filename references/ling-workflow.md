# 接入与故障

默认API，网页登录不是依赖。官方文档核验于2026-11-12：

- [快速开始](https://developer.ant-ling.com/zh-CN/docs/getting-started/quickstart/)
- [OpenAI兼容接口](https://developer.ant-ling.com/zh-CN/docs/api-reference/chat/openai)
- [多模态输入](https://developer.ant-ling.com/en/docs/tutorials/multimodal-understanding/)
- [官方控制台](https://chat.ant-ling.com/open)

`POST https://api.ant-ling.com/v1/chat/completions`，Bearer认证，固定`model: Ling-3.2-flash`。流式响应；默认`thinking: {type: disabled}`；仅传`max_completion_tokens`一种长度字段。PNG/JPEG使用data URL，总请求小于32MiB，旧HTML入口最多4张；多模态入口最多40张并按4张分批审核。只保存最终正文，不保存思考和错误响应正文。

## 一次性配置

```bash
node scripts/configure.mjs
node scripts/ling_generate.mjs --check-config
```

第一条需用户自己的交互终端，隐藏输入；第二条无网络。密钥从`LING_API_KEY`或私有配置读取，配置位于`~/.config/ling-math-demo/ling.json`，不可放Skill包中。用户明确选择其他HTTPS服务时，在私有配置明确`base_url`，且必须提供指定模型；回执标记`custom_https`。不要用其他版本假冒百灵。

创建凭证、实名认证、权限、余额和费用按平台实际说明；缺条件时报告具体阻塞，不承诺免费，不替用户开通付费。

| 结果 | 处理 |
|---|---|
| 缺Key | 用户在本机配置一次，不发送到聊天 |
| 401/403 | 停止，核对密钥与模型权限 |
| 429或验证码 | 停止该路径，不切账号或后端 |
| 502/503/504或无正文网络中断 | 最多一次受限重试，记录次数 |
| 截断、缺完整HTML | 失败且保留正文；缩小功能或在用户知情下调整预算 |
| 响应模型不符或缺模型名 | 无法核验指定模型，停止 |
| 技术或数学有误 | 反馈真实错误和截图给同一模型，不用基准样例替换 |

## 可选网页手动实测

[Ling Studio](https://chat.ant-ling.com/chat)可作无API的人工体验。先核对Ling-3.2-flash与工具开关。登录、验证码由用户本人完成；仅上传有权展示的素材。保存原始回复HTML，实际运行、截图后反馈。网页没有本地工具时由宿主Agent执行，不宣称模型在网页内独立使用了工具。

网页受登录和上传限制，不是稳定的一句话API路径。临时权限变化需已有授权，结束恢复原状态。浏览器人工操作、失败、模型输出、本地代码分别记录。

## 本地模拟

`--test-localhost`只允许显式配置的loopback HTTP。回执`transportMode: test`，总清单`simulated: true, modelGenerated: false`。这只验证请求与截图反馈链，不能证明真实模型能力。

原生看图/视频入口、精确video_url字段及本地限制见[多模态流程](multimodal.md)。
