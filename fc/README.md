# fc/ — moved

阿里云 FC / 共享 Go API 已迁至 [`faas/`](../faas/)。

| 原路径 | 新路径 |
|--------|--------|
| `fc/cmd`、`fc/internal`、`fc/go.mod` | [`faas/`](../faas/) |
| `fc/s.yaml`、`env.yaml`、`scripts/`、`env.fc.example` | [`faas/providers/aliyun-fc/`](../faas/providers/aliyun-fc/) |
| 操作说明 | [`faas/providers/aliyun-fc/README.md`](../faas/providers/aliyun-fc/README.md) |
| 共享 API 说明 | [`faas/README.md`](../faas/README.md) |

常用命令：

```bash
cd faas && go test ./...
npm run fc:deploy -- test   # → faas/providers/aliyun-fc/scripts/deploy.ts
```

架构约定：[`docs/20260802-faas-multi-cloud.md`](../docs/20260802-faas-multi-cloud.md)。
