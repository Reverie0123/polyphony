# 复调 Polyphony

把几个 AI 模型拉进一个群，像微信一样聊：@ 谁谁答，回复引用某条消息，每条消息标价。可选「自由讨论 N 轮」让它们互审；拉进 [DeskDock](https://github.com/Reverie0123/deskdock) 就能让群里的一个成员动手操作你的电脑。

[English](README.md)

> 0.1.0 开发中：联系人、单聊与群聊、附件与看图员、滚动摘要、自由讨论、DeskDock 成员、更新器、安装包都已实现；等真实 Key 联调后发布。

## 它是什么

- **联系人 = 一个具体型号**。DeepSeek、OpenAI 兼容中转站、Anthropic、本地 Ollama，以及本机已登录的 `claude` / `codex` 命令行（走你的订阅）。
- **拉群**：建群时写群简介（「审我的论文」「玩狼人杀」）、每人一张角色卡、每轮预算。
- **@ 谁谁答**：没人 @ 就没人说话。可以回复某一条消息，被 @ 的模型会收到那条原文。
- **钱算清楚**：每条回复底下显示人民币（或美元）、输入输出和缓存命中的 token、耗时；侧板看本会话、今日、按服务商的累计。
- **隐私明示**：发送前一行常驻「这条会发给：DeepSeek、Claude」；本地 Ollama 标「不出网」；「悄悄话」只给被 @ 的看。
- **上下文可控**：每次调用只带系统提示 + 滚动摘要 + 最近 N 条 + 引用那条，不会越聊越贵。

## 安装（三选一）

1. **安装包**：从 Releases 下载 `Polyphony-Setup-x.y.z.exe`，双击装到用户目录，不需要管理员权限，内置便携版 Node。
2. **一行脚本**：`powershell -ExecutionPolicy Bypass -File install.ps1`，没有 Node 会自动下载便携版，装到 `%LOCALAPPDATA%\polyphony`，开始菜单会多一个「Polyphony 复调」。
3. **已有 Node 22 以上**：`npx polyphony-chat`。

启动后在本机 7331 端口起服务并用 Edge 应用模式打开窗口。数据存在 `%APPDATA%\Polyphony\`（环境变量 `POLYPHONY_HOME` 可改），Key 只在本机。设置里可以检查更新、打开局域网访问（显示带令牌的二维码，手机同一 Wi-Fi 扫码即用）。

命令行参数：`--no-open` 不开窗口，`--port` 改端口，`--data-dir` 改数据目录，`--reset-token` 换令牌。

## DeskDock

把 [DeskDock](https://github.com/Reverie0123/deskdock) 拉进群，它就是一个能操作你电脑的成员：给它选一个支持工具调用的驱动模型，然后「@DeskDock 打开记事本写一句话」。每一步显示为可展开的卡片；权限表和审计日志都在 DeskDock 那边。设置页能检测、安装、重启它。

## 开发

```bash
npm install
npm run build
npm test
node dist/index.js --no-open
```

设计方案与调研在 `docs/`。

## 协议

MIT
