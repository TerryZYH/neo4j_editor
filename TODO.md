# 待优化事项

## 使用说明

- 每条事项格式：`- [ ] 描述` 表示待办，`- [x] 描述` 表示已完成
- 优先级标签：`[高]` `[中]` `[低]`
- 完成后在描述后注明完成日期，例如 `✓ 2026-03-31`

---

## 已完成

- [x] **[高] 去掉「加载图谱」按钮，改为断线重连后自动刷新** ✓ 2026-03-31
  - 登录后已自动加载，WebSocket 实时同步增删改，断线重连时调用 `loadCurrentView()` 补齐遗漏变更

---

## 待办

### 高优先级

- [x] **[高] 去掉 `/api/status` 轮询** ✓ 2026-03-31
  - 删除 `checkStatus` 函数及两处 `setInterval(checkStatus, 30000)` 注册
  - 改为 `setConnectionStatus(bool)`：`ws.onopen` 设绿色「已连接」，`ws.onclose` 设红色「已断线」

- [x] **[高] 删除后端废弃端点 `POST /api/relationships`** ✓ 2026-03-31
  - 删除旧端点及对应的 `RelationshipCreate` schema（均已无前端调用）

### 中优先级

- [x] **[中] 合并 `loadGraph` 和 `loadWorkspaceGraph`** ✓ 2026-03-31
  - 提取公共逻辑为 `_applyGraphData(data, toastMsg)`，两个函数各自只保留数据获取和特有逻辑

- [x] **[中] 提取 `addNodeToWorkspace` 和 `addAllFilteredNeighbors` 公共逻辑** ✓ 2026-03-31
  - 提取 `_syncWorkspaceGraph(toastMsg)` 公共函数，两个调用点各缩减约 15 行

- [x] **[中] 删除后端 `GET /api/search` 端点** ✓ 2026-03-31
  - 前端搜索在本地已加载节点中过滤，该端点从未被调用，已删除

### 低优先级

- [x] **[低] 合并 `renderRelTypeList` 和 `refreshLabels` 的重复逻辑** ✓ 2026-03-31
  - 提取 `_renderFilterList({ listId, items, activeSet, onToggle, badgeId, clearBtnId, emptyText })`，两个函数各缩减为 ~10 行

- [x] **[低] 统一 `saveNodePositions` 的 setTimeout 延迟值** ✓ 2026-03-31
  - 顶部新增常量 `PHYSICS_SETTLE_MS = 3000`，替换全部 4 处硬编码延迟（含 2000ms/2500ms/3000ms）
