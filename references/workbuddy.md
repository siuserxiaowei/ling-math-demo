# 在WorkBuddy使用

WorkBuddy可读取本地Skill并执行脚本。当前包已提供可迁移脚本与本地体检，尚未在WorkBuddy桌面客户端完成端到端实测，不能将文档支持等同于已认证兼容。

## 放入项目

将完整`ling-math-demo`目录放到WorkBuddy项目的`.codebuddy/skills/`下，结构为：

```text
项目目录/
  .codebuddy/skills/ling-math-demo/
    SKILL.md
    package.json
    scripts/
    references/
    assets/
```

官方另一入口是“专家·技能·连接器 → 技能 → 添加技能 → 上传技能”。分享时可使用`SKILL.md`位于ZIP根目录的WorkBuddy专用包；若导入器不接受，解压后按上面的项目目录路线安装。专用ZIP整理了结构，不代表已经在客户端实测其导入器。

普通Skill没有声明Connector运行时，Node/Python/浏览器/FFmpeg仍需当前电脑可执行。无需为本Skill新增MCP Connector，也不需要统一关闭WorkBuddy安全保护；按官方权限提示允许本次项目所需的文件、命令和百灵API访问即可。

## 首次本地检查

对WorkBuddy说：

> 读取当前项目的ling-math-demo Skill，先执行scripts/doctor.mjs，只检查本地环境和配置，不请求百灵API、不生成视频。已有依赖请复用，缺失时列出修复命令。不要读取或显示Key。

Agent解析Skill目录后执行：

```bash
node scripts/doctor.mjs
```

已在其他位置安装Playwright时可传`--playwright-module PATH`。体检会检查Node22+、Python3.10+、FFmpeg/FFprobe、libx264和Chromium能否实际启动，输出JSON。它不检查API余额或服务当前可用性，也不会自动安装依赖。

缺浏览器依赖时，在Skill目录执行`npm install`和`npx playwright install chromium`。FFmpeg需要带libx264，并让ffmpeg和ffprobe可执行。缺百灵Key时，在用户自己的终端运行`node scripts/configure.mjs`，它会自动选择Python后启动隐藏输入；不要粘贴Key进聊天或命令参数。已有同机配置在WorkBuddy获准访问时可复用。

macOS/Linux通常使用python3；Windows可能只有python或py -3。脚本会探测实际Python3.10+命令；如果系统旧python3遮住新版本，还会查找PATH中的python3.14等版本命令。以参数数组执行，不依赖shell别名。此项有模拟Windows测试，尚未真实Windows/WorkBuddy验证。字体、PATH与沙箱权限仍需在目标电脑检查。

## 后续一句话

> 使用ling-math-demo，给五年级孩子解释为什么0.3乘0.2等于0.06。他总算成0.6，用一百格演示，留时间让他想一想，最后用一道类似题检查理解。交付百灵旁白、中文字幕的MP4和家长使用提示。

教师可改为“给五年级课堂讲小数乘法的算理，学生总把小数点点错，制作讲解视频和教师提问提示”。年级、卡点和使用者只说已知信息，Agent可说明推定，不应为常规颜色或时长反复追问。

默认创作模型为Ling-3.2-flash，配音为官方Ming API；WorkBuddy负责调度本地脚本与审查。服务失败保留真实状态。复用材料和宿主修订分别记录，不保证新的生成结果逐帧一致，也不把技术检查称为学生学习效果验证。

## 官方依据

- [WorkBuddy技能管理](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)：本地技能上传与调用。
- [项目配置](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project)：项目`.codebuddy/skills/`目录。
- [权限与沙箱](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)：本地文件、命令与联网权限。

以上官方文档已在本次会话读取；客户端实际入口以安装版本为准。
