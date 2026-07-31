# DigitalTwin2026 开发日志

> 日期：2026-07-31
> 状态：详情 Admin 编辑收尾 + 本地 Go API / 设置页加速地址（FC 部署未做）

## 0. 今日做成了什么（总览）

在已有查询 / 列表 / 详情只读之上，补齐 **Admin 就地改记录**：一次草稿、一次提交，双击进出编辑尽量零重排。另：落地阿里云 FC 计划的**第一期子集**（前端加速地址 + 本地可跑 Go HTTP API）。

| 类别 | 已完成 |
|------|--------|
| Admin API | `PATCH /api/admin/records/[id]`；proxy 仅 Admin Token |
| 校验 | `src/lib/record-draft.ts` 前后端共用；单元 + 路由集成测试 |
| 详情 UI | 双击编辑草稿；脏数据才显示「提交」；成功 refetch；失败展示 error |
| Null | `NullBadge`：斜体淡色、不可选中；真实 `'-'` / `''` 原样 |
| 标签 | 无逗号独立 chip；编辑仅显隐 `×` / `+`；修复占位塌缩导致的文字跳动 |
| 文档 | README / 本日志；0730 待办勾选「详情双击编辑」 |
| Go API（本地） | `fc/`：`go run ./cmd/api`，7 路由 + CORS + 鉴权对齐；`go test ./...` |
| 设置页加速 | prefs `apiAccelerateBase`；`api-client` 拼 base；空=同源 |

## 1. Admin PATCH

- 路径：`PATCH /api/admin/records/[id]`
- Body：可编辑字段快照（`happened_at`、`value_number`、`value_text`、`tags`、`objective_context`、`subjective_interpretation`）
- 规则要点：
  - 空串 → `null`（`objective_context` 除外，不允许空）
  - `value_number` / `value_text` 不能同时为空
  - `tags` 非空且每项 `isValidTag`
  - `happened_at` 必填且带时区偏移
- 前端提交时间：人只选墙钟（`datetime-local`），提交时用 `resolveTimezone()` 拼偏移（与 Dashboard / query 一致）

相关：`src/app/api/admin/records/[id]/route.ts`、`src/lib/record-draft.ts`、`src/lib/api-client.ts`。

## 2. 详情页双击编辑

- 有 Admin Token：双击可编辑区进入草稿态
- 无 Admin：双击提示「无编辑权限」，不进入编辑
- 硬约束：**零重排**——尽量不因换成控件而改变字号、边距、块尺寸
- 字段交互：
  - 时间：日期时间选择器（无时区控件）
  - 数值：光标 + 默认全选
  - 文本 / 客观 / 主观：contentEditable；Null 从空串起编
  - 标签：chip 行内删 / `+` 搜选或回车新建
- 仅草稿相对服务端有差异时显示提交按钮；成功后 refetch 并退出编辑态

相关：`src/app/records/[id]/page.tsx`、`src/components/null-badge.tsx`、`src/components/record-tag-chips.tsx`、`src/lib/datetime-ui.ts`。

## 3. 标签 chip 布局修正

现象：只读 → 编辑时标签文字向左跳。

原因：每个 chip 曾用左侧 `invisible` × + 右侧 ×；进入编辑后左侧改为 `hidden`，占位塌缩。

修正：去掉左侧对称占位；只保留右侧固定宽 `×` 与末尾 `+`，只读用 `invisible` 占位、编辑可见，**不用 `hidden`**，盒模型宽度切换前后一致。

## 4. 今日提交

```
50507eb 修复标签 chip 双击编辑时左侧 × 占位塌缩导致文字跳动。
6a63995 实现记录详情双击编辑：零重排草稿与标签 chip。
f117da6 添加 Admin PATCH 更新记录接口与草稿校验。
```

## 5. 本地 Go API + API 加速地址（FC 第一期子集）

- 目录：`fc/`（标准 `net/http`，不依赖阿里云 SDK 即可本地跑）
- 路由与鉴权对齐现有 Next：`/api/log/*`、`/api/query*`、`/api/admin/*`
- 设置页「API 加速地址」：本机 prefs；**不用** `NEXT_PUBLIC_*`；真实 FC URL **不进 git**
- **未做**：Serverless Devs / `s.yaml` / 控制台部署 / 实际上线

本地验证：

```bash
cd fc && export $(grep -v '^#' ../.env | xargs) && go run ./cmd/api
# 设置页填 http://localhost:8080
cd fc && go test ./...
```

## 6. 仍待办（摘自 0730 §10）

- 专用录入接口（账单、体重、复盘等）
- 账单汇总 `GET /query/bill/summary`
- Dashboard 其它组件（体重/支出等）
- AI 侧 CLI 包装
- 数据库 COMMENT、数据导出
- **阿里云函数计算部署**（CLI / s.yaml / test→prod；前端+本地 Go 已就绪，0730 该项仍不勾）
- 前端：记录删除 / 图表 / 列表行内编辑
