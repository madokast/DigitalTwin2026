# 2026-08-03 发展日志

## 破坏性变更：HTTP JSON / JSONL 全量 snake_case

对外 HTTP JSON 与 JSONL 键名一律改为 snake_case（如 `happened_at`、`value_number`、`page_size`）；**不**兼容旧 camelCase。复盘 `POST /api/log/review` 仍暂停。规范已写入根 `AGENTS.md`。
