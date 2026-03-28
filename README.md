# Neo4j 图谱编辑器

基于 Web 的 Neo4j 知识图谱可视化与协同编辑系统，支持多用户实时协作、属性约束管理和轻量级本体定义。

## 功能概览

| 模块 | 功能 |
|------|------|
| 图谱编辑 | 节点/边的增删改查，属性编辑，vis-network 可视化 |
| 多用户协作 | WebSocket 实时锁定，编辑中状态提示，锁冲突保护 |
| 属性模板 | 枚举约束，下拉选择，防止属性值写错 |
| 本体管理 | 类定义（节点标签）、关系三元组约束、校验模式 |
| 管理后台 | 用户管理，会话查看，强制解锁 |
| 数据初始化 | 从现有图谱自动提取本体和属性枚举 |

## 技术栈

- **后端**: Python · FastAPI · WebSocket · SQLite
- **图数据库**: Neo4j（Bolt 协议）
- **前端**: 原生 HTML/JS · [vis-network](https://visjs.github.io/vis-network/)
- **认证**: JWT（python-jose）· sha256_crypt（passlib）

## 目录结构

```
neo4j_edit/
├── backend/
│   ├── main.py          # FastAPI 主入口，图谱 CRUD + WebSocket
│   ├── auth.py          # 用户注册/登录，JWT 认证
│   ├── admin.py         # 管理员接口（用户、会话、锁）
│   ├── schemas.py       # 属性模板（枚举约束）
│   ├── ontology.py      # 本体管理（类定义、关系约束）
│   ├── ws_manager.py    # WebSocket 连接与实体锁管理
│   ├── init_schemas.py  # 从 Neo4j 自动初始化本体和属性枚举
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── index.html       # 图谱编辑主界面
│   ├── ontology.html    # 本体管理界面
│   └── admin.html       # 管理后台界面
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## 快速开始

### 方式一：Docker Compose（推荐）

**前置依赖**：Docker 和 Docker Compose

```bash
# 1. 复制并填写环境变量
cp .env.example .env
# 编辑 .env，设置 NEO4J_PASSWORD 和 SECRET_KEY

# 2. 启动所有服务（Neo4j + 后端）
docker compose up -d

# 3. 查看启动日志
docker compose logs -f backend

# 4. 停止服务
docker compose down

# 停止并清除所有数据卷（慎用，会删除图谱数据）
docker compose down -v
```

启动后访问：
- 应用主界面：`http://localhost:8000`
- Neo4j Browser：`http://localhost:7474`（用户名 `neo4j`，密码同 `.env` 中设置）

> 首次启动 Neo4j 约需 30 秒初始化，后端会等待 Neo4j 就绪后再启动。

**数据持久化**：SQLite 数据存储在 Docker 卷 `sqlite_data`，Neo4j 图谱数据存储在 `neo4j_data`，重启容器数据不丢失。

---

### 方式二：本地开发

#### 1. 前置依赖

- Python 3.10+（推荐 conda 环境）
- Neo4j 4.x / 5.x（本地或远程，Community 版即可）

#### 2. 安装依赖

```bash
conda create -n neo4j_editor python=3.12
conda activate neo4j_editor
pip install -r backend/requirements.txt
```

#### 3. 配置环境变量

复制并编辑 `.env` 文件：

```bash
cp backend/.env.example backend/.env
```

```ini
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_neo4j_password
SECRET_KEY=your-random-secret-key   # 用于 JWT 签名，随机字符串即可
```

#### 4. 启动后端

```bash
conda run -n neo4j_editor uvicorn main:app --port 8000
```

或进入目录后：

```bash
cd backend
uvicorn main:app --port 8000 --reload
```

首次启动会自动在 `backend/` 目录下创建：
- `users.db` — 用户账户数据库
- `schemas.db` — 属性模板 + 本体数据库

#### 5. 打开前端

直接在浏览器中打开 `frontend/index.html`，或通过任意静态文件服务器访问。

> FastAPI 已挂载 `frontend/` 为静态目录，也可访问 `http://localhost:8000`

#### 6. 注册账号

首次访问会跳转到登录页。点击「注册」，**第一个注册的用户自动成为管理员**。

---

## 初始化本体和属性模板

如果 Neo4j 中已有图谱数据，可以用 `init_schemas.py` 一键从现有数据中提取本体结构和属性枚举，无需手动录入。

### 获取登录 Token

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"你的用户名","password":"你的密码"}'
# 返回 {"token": "eyJ...", ...}
```

### 运行初始化脚本

```bash
conda run -n neo4j_editor python backend/init_schemas.py <TOKEN>
```

脚本会自动提取并写入：

| 类型 | 内容 |
|------|------|
| **类定义** | Neo4j 中每个 Label 对应一个类，自动分配颜色 |
| **关系三元组** | 图中实际存在的 `(源标签)-[关系类型]->(目标标签)` |
| **属性枚举** | distinct 值在 2~20 之间且不是唯一标识字段的属性 |

**唯一标识字段过滤规则**：若某属性的 `distinct值数 / 节点总数 ≥ 0.7`，视为唯一标识（如 name、id），自动跳过，不生成枚举约束。

---

## 核心功能说明

### 多用户协同编辑

- 所有用户通过 WebSocket 连接到同一图谱
- 用户打开节点/边编辑框时，该实体自动上锁
- 其他用户视角：被锁定的实体显示「正在被 xxx 编辑」，无法点击编辑
- 编辑完成或关闭弹窗时自动解锁
- 用户断开连接时，持有的所有锁自动释放
- 管理员可在后台强制解锁任意实体

### 属性模板（枚举约束）

在主界面侧边栏点击「📋 属性模板」可管理属性枚举：

- `entity_type`: `node`（节点）或 `edge`（边）
- `entity_label`: 对应的节点标签或关系类型，`*` 表示所有
- `prop_key`: 属性键名；特殊值 `__rel_type__` 用于限制边的关系类型
- `enum_values`: 合法值列表，编辑时渲染为下拉选择框

### 本体管理

访问 `frontend/ontology.html`（或点击顶部导航「🧬 本体」）：

**Tab 1 — 类定义**：定义合法的节点标签，可设置显示名、颜色、图标

**Tab 2 — 关系约束**：定义合法的关系三元组 `(源类型)-[关系类型]->(目标类型)`；页面右侧有可视化图谱展示整体本体结构

**Tab 3 — 校验设置**：
- `warn` 模式（默认）：违反本体时显示警告，但仍允许保存
- `strict` 模式：违反本体时阻止保存，返回 HTTP 422 错误

---

## API 概览

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录，返回 JWT token |
| GET  | `/api/auth/me` | 获取当前用户信息 |

### 图谱操作

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/graph` | 获取全量节点和边 |
| POST | `/api/nodes` | 创建节点 |
| PUT  | `/api/nodes/{id}` | 更新节点 |
| DELETE | `/api/nodes/{id}` | 删除节点 |
| POST | `/api/relationships` | 创建关系 |
| PUT  | `/api/relationships/{id}` | 更新关系 |
| DELETE | `/api/relationships/{id}` | 删除关系 |
| POST | `/api/cypher` | 执行 Cypher 查询 |
| WS   | `/ws/{user_id}` | WebSocket 实时协作 |

### 本体

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/ontology` | 获取完整本体（类 + 关系 + 配置） |
| GET/POST | `/api/ontology/classes` | 类定义列表 / 创建 |
| PUT/DELETE | `/api/ontology/classes/{id}` | 更新 / 删除 |
| GET/POST | `/api/ontology/relations` | 关系约束列表 / 创建 |
| DELETE | `/api/ontology/relations/{id}` | 删除 |
| GET/PUT | `/api/ontology/config` | 获取/更新校验模式 |

### 属性模板

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/schemas` | 获取所有属性模板 |
| POST | `/api/schemas` | 创建属性模板 |
| PUT  | `/api/schemas/{id}` | 更新 |
| DELETE | `/api/schemas/{id}` | 删除（仅创建者或管理员） |

### 管理员

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/admin/users` | 用户列表 |
| PUT  | `/api/admin/users/{id}` | 修改用户角色/状态 |
| DELETE | `/api/admin/users/{id}` | 删除用户 |
| GET  | `/api/admin/sessions` | 当前在线会话 |
| GET  | `/api/admin/locks` | 当前所有锁 |
| DELETE | `/api/admin/locks/{entity_id}` | 强制解锁 |

---

## 数据存储

| 文件 | 内容 |
|------|------|
| `backend/users.db` | 用户账户（SQLite） |
| `backend/schemas.db` | 属性模板 + 本体定义（SQLite） |
| Neo4j 数据库 | 图谱节点和边 |

> `users.db` 和 `schemas.db` 已加入 `.gitignore`，不会提交到版本库。

---

## 注意事项

- Neo4j **Community 版**仅支持单个数据库，本项目不做多图谱切换
- 实体锁存储在内存中，**重启后端锁会自动清除**
- 建议在生产部署前修改 `SECRET_KEY` 为足够随机的字符串
- 如需在公网部署，建议在 FastAPI 前加 Nginx 反代并启用 HTTPS
