# opencode-master

多租户 opencode 云的主控协调器（Master）。**对外唯一入口**：Web/客户端只与 master 通信，opencode 执行器（slave）完全隐藏在内网。

对应设计文档：[`../opencode-cloud-master-slave-design.md`](../opencode-cloud-master-slave-design.md)（§1 Master 功能、§2 Slave 改造、§8 会话容错）。

## 架构

```
┌─ Web / SDK（只与 Master 通信）──────────────────────────────┐
│  建会话 → prompt → SSE 事件流 → 结束会话                     │
└──────────────┬─────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────┐
│ opencode-master（本包）                                     │
│  M1 身份(JWT/API Key)  M2 路由放置(一致性哈希+负载)          │
│  M3 会话租约(TTL)      M4 故障接管(心跳超时→re-home)         │
│  M5 prompt 背压队列    M6 配额    M7 事件聚合(SSE)           │
└───────┬──────────────────────────────┬─────────────────────┘
        │ ①注册+心跳 ②事件上抛 ③指令    │ ④prompt 下发(拉取)
┌───────▼──────────────────────────────▼─────────────────────┐
│ opencode-slave（sidecar 包装，见 scripts/simulate-slave.ts）│
│  spawn/守护 `opencode serve` + 心跳 + 事件桥 + prompt 桥     │
└────────────────────────────────────────────────────────────┘
```

**关键设计**：master 生成的 `ses_*` session id 直接作为 opencode 的 session id（opencode `POST /api/session` 支持自定义 id），因此 **master 会话 ≡ opencode 会话**，无需映射；opencode 只监听回环地址，slave 是唯一访问者。

## 存算分离边界

Master 是会话、turn、事件和租约的持久化事实来源；Worker/OpenCode 只是可替换的计算后端：

```
客户端 → Master（SQLite/Postgres：turn、事件、租约、workspace 元数据）
                    ↓ turnID + leaseEpoch
             Worker（临时执行环境，CubeFS 挂载） → OpenCode
                    ↓ 语义事件（幂等上报）
             Master 事件日志 → SSE / 历史
```

- prompt 先在 Master 中创建幂等 turn，再下发 Worker；重复的 `idempotencyKey` 不会重复执行。
- Worker 事件由 Master 持久化并提供 SSE 回放；浏览器和历史查询不依赖 Worker 仍在线。
- Worker 故障后，Master 重新放置 session 并递增 `leaseEpoch`；旧 Worker 的事件提交会被拒绝。
- 生产 Worker 通过 `CUBEFS_MOUNT_PATH` 挂载同一份 CubeFS；每个 workspace ID 映射到挂载根下的稳定目录，不做文件 hydrate/commit。
- `src/workspace` 中的 `WorkspaceSync` 仅保留给没有共享挂载的可选部署；CubeFS 主路径只做挂载就绪检查和目录映射。
- **禁止多个 OpenCode 实例共享 CubeFS 上的 `opencode.db` / `-wal` / `-shm`**。每个 Worker 使用自己的本地 SQLite；Master 的 lease 保证同一个逻辑 session 只有一个活跃 OpenCode owner。
- 当前限制：正在执行的 OpenCode 工具调用不会热迁移；恢复从 durable history 和共享 Workspace 文件开始。

## 快速开始

```bash
bun install

# 1. 启动 master（默认 0.0.0.0:4097，SQLite 数据在 ./data/master.db）
bun run src/index.ts

# 2. 启动模拟 slave（另一终端；真实场景是 opencode-slave 包装 opencode serve）
bun run scripts/simulate-slave.ts --master http://127.0.0.1:4097 --id slave-1

# 3. 跑 Web 视角 demo（第三终端）：建会话→prompt→SSE 收事件→结束
bun run scripts/demo.ts
```

## 测试

```bash
bun test          # 31 个测试：哈希分布/负载/JWT/网关契约/放置/租约/故障接管/SSE 闭环
bunx tsc --noEmit # 类型检查
```

## 对外 API（Web 可见，slave 永不可见）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活探针（公开） |
| POST | `/api/v1/auth/token` | `{apiKey, tenant?, user?, role?}` → JWT |
| POST | `/api/v1/auth/apikeys` | 用户自建 API Key（Bearer 鉴权） |
| POST | `/api/v1/sessions` | 创建会话 `{title?, directory?}` → `{session}` |
| GET | `/api/v1/sessions` | 我的会话列表 |
| GET | `/api/v1/sessions/:id` | 会话详情 |
| POST | `/api/v1/sessions/:id/prompt` | 发 prompt `{content, delivery?}` → `{prompt, stream}` |
| GET | `/api/v1/sessions/:id/events?after=N` | **SSE 事件流**（回放 + 实时推送） |
| POST | `/api/v1/sessions/:id/end` | 结束会话 |

Web 端封装：`src/client.ts` 的 `createMasterClient({ baseUrl, token })`（`stream()` 内置 SSE 断线续传，支持 `after`）。

## 内部 API（仅 admin / slave 角色，slave 地址永不出现在对外响应）

| 角色 | 端点 | 说明 |
|---|---|---|
| admin | `POST /api/v1/slaves/register` | 注册 slave → 返回 `{slave, token}`（slave JWT） |
| admin | `POST /api/v1/slaves/:id/drain` / `undrain` | 排空/恢复 |
| admin | `GET /api/v1/admin/slaves` / `sessions` | 集群视图 |
| admin | `POST /api/v1/admin/sessions/:id/rehome` | 强制迁移 |
| admin | `POST /api/v1/admin/sweep` | 手动跑一次故障扫描 |
| slave | `POST /api/v1/slaves/:id/heartbeat` | 心跳 `{load}` → `{instructions, ownedSessions}` |
| slave | `GET /api/v1/sessions/:id/prompts?after=N` | 拉取待处理 prompt（M5 背压队列） |
| slave | `POST /api/v1/sessions/:id/prompts/:promptId/delivered` | 标记已消费 |
| slave | `POST /api/v1/events/ingest` | 上抛 durable 事件（按 session seq，幂等） |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_MASTER_PORT` | 4097 | 监听端口 |
| `OPENCODE_MASTER_HOST` | 0.0.0.0 | 监听地址 |
| `OPENCODE_MASTER_DB` | ./data/master.db | SQLite 路径（`:memory:` 用于测试） |
| `OPENCODE_MASTER_JWT_SECRET` | dev-secret-change-me | JWT 签名密钥（生产必改） |
| `OPENCODE_MASTER_JWT_TTL` | 28800 | token 有效期（秒） |
| `OPENCODE_MASTER_HEARTBEAT_TIMEOUT_MS` | 15000 | 心跳超时 → 判死 |
| `OPENCODE_MASTER_LEASE_TTL_MS` | 60000 | 会话租约 TTL |
| `OPENCODE_MASTER_SCHEDULER_INTERVAL_MS` | 5000 | 故障扫描周期 |
| `OPENCODE_MASTER_BOOTSTRAP_KEY` | dev-admin-key | 引导 API Key（mint admin/user/slave token） |
| `OPENCODE_MASTER_MAX_SESSIONS_PER_USER` | 0（不限） | 每用户并发会话上限；仅设置正数时启用配额 |
| `OPENCODE_MASTER_PLACEMENT_CANDIDATES` | 3 | 每用户候选 slave 数（亲和环） |

### CubeFS Worker 挂载

每个 Worker 必须把同一个 CubeFS 文件系统挂载到相同的目录（或通过 `CUBEFS_MOUNT_PATH` 指定本机挂载点）：

```bash
CUBEFS_MOUNT_PATH=/mnt/cubefs/opencode \
bun run src/worker/index.ts --id worker-1 --master http://master:4097 \
  --credential "$OPENCODE_WORKER_PROXY_CREDENTIAL"
```

设置了 `CUBEFS_MOUNT_PATH` 后，Worker 启动时会拒绝未挂载的目录；本地开发不设置该变量时仍使用 `data/workers/<id>/workspace`。

OpenCode 的 native 数据库默认写入 Worker 的 `dataDir/opencode.db`。如果显式设置 `OPENCODE_DB`，它不能指向 CubeFS workspace；Worker 会在启动时拒绝这种配置。

## 目录结构

```
src/
  config.ts              # 环境配置
  types.ts               # 领域类型（slave/session/lease/event...）
  db/                    # drizzle schema + DDL + bun:sqlite 客户端
  auth/jwt.ts            # HS256 JWT（零依赖，WebCrypto）
  placement/             # 一致性哈希（FNV-1a+Murmur3 fmix） + 负载评分
  services/              # identity / worker-registry / turns / event-journal / session / scheduler
  workspace/             # CubeFS mounted adapter；WorkspaceSync 是非挂载部署的可选实现
  http/                  # 网关 HTTP API（Router + Master 服务器）
  client.ts              # Web 客户端 createMasterClient
  index.ts               # 入口
scripts/
  simulate-slave.ts      # 模拟 opencode-slave（闭环演示）
  demo.ts                # Web 视角端到端 demo
test/                    # bun:test 单元 + 集成（内存 DB + 假时钟）
```

## 真实部署（opencode-slave 包装，零改 opencode）

真实执行器不是"模拟"，而是：**opencode-slave sidecar spawn 一个 npm 安装的 `opencode serve`**，依赖的 opencode 官方能力（均已验证存在）：

- `POST /api/session` 支持自定义 `id` → master 的 session id 直接复用
- `POST /api/session/:id/prompt` → prompt 注入
- `GET /api/event`（SSE）→ 事件桥数据源
- `GET /api/session/active` + `/global/health` → 心跳负载
- `OPENCODE_DB` / `OPENCODE_AUTH_CONTENT` / `OPENCODE_SERVER_PASSWORD` → 每用户隔离、凭据注入、仅回环

隔离：每用户/工作区一个 slave（独立数据目录 + 独立端口 + `--directory /workspaces/<uid>`）。

---

## Web 控制台（slave 管理 + 聊天）

浏览器打开 master 地址（默认 `http://127.0.0.1:4097/`），单文件页面，无构建：

- **Slaves 面板**（勾选「管理员」+ 登录后显示，每 5s 自动刷新）：
  - 列出已注册 slave：状态点（ok/draining/unhealthy）、configVersion（配置一致性）、CPU 负载
  - **外部自注册**（`managed=false`）：多容器部署模式，slave 由编排器拉起后自动注册
  - **本地 spawn**（`managed=true`）：仅单机调试，master 在本机 spawn slave 进程
  - **填端口批量启动**：输入 `14101,14102,14103` → 启动，id 自动为 `slave-<端口>`
- **聊天**：userId 切换模拟多用户（会话/历史完全隔离）、新建会话、发消息、历史记录、工具调用内联显示

## 两种执行器（Executor）

| Executor | 用途 | 说明 |
|---|---|---|
| `--executor sim`（默认） | Web 演示 / 验收 | 内置模拟回复，**链路完全真实**（master 分发/多 slave/多用户/历史/工具调用），秒回稳定 |
| `--executor real` | 真实模型 | spawn `opencode serve` 驱动官方 API，模型凭据经 `OPENCODE_AUTH_CONTENT` 注入 |

**真实模型配置（deepseek 示例）**：

```bash
# 配置仓库 scripts/fixtures/config-repo-real/opencode.jsonc
#   agent.build.model = "deepseek/deepseek-v4-flash"   ← 注意是 build 不是 default！
#   provider.deepseek.models.deepseek-v4-flash {...}
bun run src/slave/index.ts --executor real \
  --opencode-bin ./scripts/opencode-serve.sh --opencode-port 14101 \
  --config-repo scripts/fixtures/config-repo-real \
  --auth-content '{"deepseek":{"type":"api","key":"sk-xxx"}}'
```

> ⚠️ **已知问题（opencode 上游）**：`opencode 1.18.19` serve 以源码包装方式运行（wrapper + XDG 隔离 + env 注入）时，成功回复后存在崩溃（ServeError）的兼容性问题；独立进程运行正常。修复依赖 opencode 上游版本，web 演示请使用 `sim` 执行器。

## 部署模式

- **单机调试**：master 通过 `POST /api/v1/admin/slaves/spawn` 在本机拉起 slave（需配置 `OPENCODE_MASTER_SLAVE_SPAWN_CMD` 模板）
- **生产多容器**：slave 由容器编排器（k8s 等）拉起，启动时自注册 + 心跳（`--master <master地址>`），master 不做 spawn（spawn 无法跨容器）
