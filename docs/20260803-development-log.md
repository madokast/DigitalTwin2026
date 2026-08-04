# 2026-08-03 发展日志

> **2026-08-04 变更提示**：`value_text` / `value_number` 已全量更名为 `raw_content` / `numeric_value`，todo 审计行存储语义亦已变更（本文正文保留当时原样）。详见 [`20260804-rename-value-text-to-raw-content.md`](20260804-rename-value-text-to-raw-content.md)。

## 破坏性变更：HTTP JSON / JSONL 全量 snake_case

对外 HTTP JSON 与 JSONL 键名一律改为 snake_case（如 `happened_at`、`value_number`、`page_size`）；**不**兼容旧 camelCase。复盘 `POST /api/log/review` 仍暂停。规范已写入根 `AGENTS.md`。
