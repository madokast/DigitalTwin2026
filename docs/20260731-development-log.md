# DigitalTwin2026 开发日志

> 日期：2026-07-31
> 状态：记录详情 Admin 双击编辑（PATCH）

## 做成了什么

| 项 | 说明 |
|----|------|
| Admin PATCH | `PATCH /api/admin/records/[id]`；proxy 仅 Admin；可编辑字段一次提交快照 |
| 校验 | `src/lib/record-draft.ts` 前后端共用；空串→null（objective 除外）；value 不能双空；tags/`happened_at` 带时区 |
| Null 展示 | `NullBadge`：斜体淡色、`select-none`；真实 `'-'`/`''` 原样 |
| 详情编辑 | 双击零重排；时间 `datetime-local` + 提交时 `resolveTimezone()`；数值全选；文本 contentEditable；标签 chip 仅显隐 ×/+ |
| 权限 | 无 Admin Token 双击提示「无编辑权限」 |
| 提交 | 脏数据才显示按钮；成功 refetch 退出编辑态；失败显示 error |

相关文件：`src/app/api/admin/records/[id]/route.ts`、`src/lib/record-draft.ts`、`src/components/null-badge.tsx`、`src/components/record-tag-chips.tsx`、`src/app/records/[id]/page.tsx`。
