# 原始流样本

`node scripts/record-fixtures.mjs` 会用应用里已配置的账号，向每个 API 联系人发一句「用五个字以内打个招呼」，把原始 SSE / NDJSON 响应体存成 `<provider>-<model>.txt`。已有文件不会重录。

`tests/parsers.test.mjs` 里的样本目前是按各家文档手写的；录到真实样本后把对应测试改成读这里的文件。
