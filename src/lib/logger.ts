import pino from 'pino'

// 结构化日志（双端对齐：Node pino / Go slog，见 AGENTS.md「日志」）。
// 默认 JSON 行（Vercel 采集）；键值对便于 grep 与未来 Log Drains 接第三方。
// 级别：LOG_LEVEL 环境变量（debug/info/warn/error），默认 info。
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
})
