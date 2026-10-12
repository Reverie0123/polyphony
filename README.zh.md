# 复调 Polyphony

把几个 AI 模型拉进一个群，像微信一样聊：@ 谁谁答，回复引用某条消息，每条消息标价。可选「自由讨论 N 轮」让它们互审；拉进 [DeskDock](https://github.com/Reverie0123/deskdock) 就能让群里的一个成员动手操作你的电脑。

[English](README.md)

> 开发中。第一阶段（联系人、单聊与群聊基础、费用）已可用，自由讨论和 DeskDock 成员在后续阶段。

## 它是什么

- **联系人 = 一个具体型号**。DeepSeek、OpenAI 兼容中转站、Anthropic、本地 Ollama，以及本机已登录的 `claude` / `codex` 命令行（走你的订阅）。
- **拉群**：建群时写群简介（「审我的论文」「玩狼人杀」）、每人一张角色卡、每轮预算。
- **@ 谁谁答**：没人 @ 就没人说话。可以回复某一条消息，被 @ 的模型会收到那条原文。
- **钱算清楚**：每条回复底下显示人民币（或美元）、输入输出和缓存命中的 token、耗时；侧板看本会话、今日、按服务商的累计。
- **隐私明示**：发送前一行常驻「这条会发给：DeepSeek、Claude」；本地 Ollama 标「不出网」；「悄悄话」只给被 @ 的看。
- **上下文可控**：每次调用只带系统提示 + 滚动摘要 + 最近 N 条 + 引用那条，不会越聊越贵。

## 运行

需要 Node 22 以上。

```bash
npx polyphony-chat
```

会在本机 7331 端口起服务并用 Edge 应用模式打开窗口。数据存在 `%APPDATA%\Polyphony\`（环境变量 `POLYPHONY_HOME` 可改），Key 只在本机。

命令行参数：`--no-open` 不开窗口，`--port` 改端口，`--data-dir` 改数据目录，`--reset-token` 换令牌。

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
