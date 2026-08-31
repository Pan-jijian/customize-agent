---
"@customize-agent/llm": patch
"@customize-agent/server": patch
---

LLM 请求硬超时兜底：OpenAI SDK 内建 timeout 仅在响应头到达前生效，DeepSeek HTTP/2 长请求「响应头已回但 body 挂起」会让 fetch Promise 永久悬挂，文档流水线修复循环随之卡死（实测真实生成 20+ 分钟无进展）。provider 层新增 hardTimeoutSignal（AbortSignal.timeout 与调用方 signal 组合，默认 10 分钟，LLM_REQUEST_TIMEOUT_MS 可调）覆盖全链路；超时/abort 类错误纳入瞬态识别重试一次，服务端 stall 后任务可自愈继续而非永久卡死。
