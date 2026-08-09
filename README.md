# mcp_file_manager

> 通过 mcp 服务实现用户/ai agent 上传/下载文件并生成对应链接，每次进行上传操作时都生成对应标识码供 ai 查找，文件 24 小时后自动删除。

一个开箱即用的文件中转 MCP 服务：AI 和人都可以把文件扔进来，拿到一个**标识码**和一个**可直接分享的下载链接**；之后只要报出标识码，AI 就能重新找到并读取这个文件。所有文件**默认保留 24 小时，到期自动删除**。

## 特点

- **双向可用**：AI 用 MCP 工具上传/下载；人用浏览器页面上传/下载。两边共用同一套存储与标识码。
- **标识码友好**：Crockford Base32（已剔除 `I/L/O/U`），展示为 `7K2QF-9XM4T`；查找时大小写、连字符、`0/O` `1/I/l` 混淆全都宽容。
- **24 小时自动清理**：后台守护任务每 10 分钟扫一次，启动时也扫一次（覆盖停机期间到期的文件），同时回收无主文件与失效上传链接。
- **全流式写盘**：边写盘边算 SHA-256 并计数，超限立即中断，不把整个文件读进内存。
- **四种上传源**：base64 内容、纯文本、服务器本地路径、远程 URL。
- **两种传输**：`stdio`（供 Claude Desktop / Cursor 等客户端拉起）与无状态 `Streamable HTTP`（供远程部署）。
- **零依赖存储**：本地文件系统 + 原子写入的 `index.json`，不需要数据库或对象存储。

> 关于保留期：仓库最初的描述是 14 天，本实现按最新要求改为 **24 小时**。保留期完全可配（`FM_TTL_HOURS`），如需恢复 14 天只需设为 `336`。

## 快速开始

需要 Node.js >= 20.11。

```bash
npm install
cp .env.example .env   # 可选，不改也能跑
npm run dev            # 开发模式：stdio + 本地文件服务
npm run build && npm start
```

启动后浏览器打开 <http://localhost:8787> 即为上传页面。

作为远程 HTTP 服务部署：

```bash
FM_HOST=0.0.0.0 FM_API_TOKEN=你的强密钥 npm run start:http
# MCP 端点：POST http://<host>:8787/mcp
```

### 接入 MCP 客户端（stdio）

参见 [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json)：

```json
{
  "mcpServers": {
    "file-manager": {
      "command": "node",
      "args": ["/绝对路径/mcp_file_manager/dist/index.js"],
      "env": {
        "FM_DATA_DIR": "/绝对路径/mcp_file_manager/data",
        "FM_PUBLIC_BASE_URL": "http://localhost:8787",
        "FM_TTL_HOURS": "24"
      }
    }
  }
}
```

> stdio 模式下会**同时**启动本地文件 HTTP 服务，否则生成的下载链接没人响应。不需要时加 `--no-http`。
> 日志一律输出到 stderr，stdout 留给 MCP 的 JSON-RPC 通道。

## MCP 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `upload_file` | 上传文件，返回标识码与链接 | `content`(base64) / `text` / `path` / `url` 四选一，`name`、`tags`、`ttlHours` |
| `download_file` | 按标识码取回内容 | `code`、`savePath`、`encoding`(auto/utf-8/base64/none) |
| `get_file_info` | 只看元数据与链接 | `code` |
| `list_files` | 列表/搜索（忘记标识码时用） | `query`、`tag`、`limit`、`sort` |
| `delete_file` | 不等到期，立即删除 | `code` |
| `extend_expiry` | 重算为“从现在起再保留 N 小时” | `code`、`hours` |
| `create_upload_link` | 生成给人用的临时上传页面 | `note`、`expiresInMinutes`、`maxUses`、`fileTtlHours` |
| `sweep_expired` | 手动触发一次到期清理 | — |
| `get_storage_stats` | 文件数、占用、保留策略、下一个到期时间 | — |

典型对话：

1. 用户：“把这份报价单存一下。” → AI 调 `upload_file` → 回复标识码 `7K2QF-9XM4T` + 下载链接 + “24 小时后自动删除”。
2. 用户（稍后）：“7K2QF-9XM4T 里的金额是多少？” → AI 调 `download_file` 直接读内容。
3. 需要用户提供文件时：AI 调 `create_upload_link` → 发出一个 `/u/<ticket>` 链接 → 用户上传后页面直接展示标识码。

## HTTP 接口

| 方法 | 路径 | 说明 | 鲁棒 |
| --- | --- | --- | --- |
| GET | `/` | 上传页面 | 否 |
| GET | `/healthz` | 健康检查 | 否 |
| POST | `/api/upload` | multipart 上传（字段名 `file`） | 是 |
| GET | `/f/:code` · `/f/:code/:filename` | 下载（`?inline` 可在浏览器内预览） | 否（标识码即凭证） |
| GET | `/api/files/:code` | 单文件元数据 JSON | 否 |
| GET | `/api/files` | 列表/搜索 | 是 |
| DELETE | `/api/files/:code` | 删除 | 是 |
| POST | `/api/files/:code/extend` | 延期，体 `{"hours":48}` | 是 |
| GET | `/api/stats` · POST `/api/sweep` | 状态与手动清理 | 是 |
| GET/POST | `/u/:ticket` | 临时上传页面与提交 | 否（票据即凭证） |
| POST | `/mcp` | 无状态 Streamable HTTP MCP 端点 | 是 |

鲁棒方式（三者均可，仅在设置了 `FM_API_TOKEN` 时生效）：`Authorization: Bearer <token>`、`X-API-Token: <token>`、`?token=<token>`。

```bash
# 上传
curl -X POST http://localhost:8787/api/upload \
  -H "Authorization: Bearer $FM_API_TOKEN" \
  -F "file=@./report.pdf" -F "tags=财务,Q3" -F "ttlHours=48"

# 下载
curl -OJ http://localhost:8787/f/7K2QF9XM4T
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FM_TTL_HOURS` | `24` | **默认保留时长（小时）**，到期自动删除 |
| `FM_MAX_TTL_HOURS` | `720` | 单次请求可申请的保留上限（30 天） |
| `FM_SWEEP_INTERVAL_MINUTES` | `10` | 到期清理扫描间隔 |
| `FM_DATA_DIR` | `./data` | 数据目录（`files/`、`tmp/`、`index.json`） |
| `FM_HOST` / `FM_PORT` | `127.0.0.1` / `8787` | HTTP 监听地址 |
| `FM_PUBLIC_BASE_URL` | `http://<host>:<port>` | 拼接对外链接用，反代/域名下必须设置 |
| `FM_API_TOKEN` | 空 | 写接口鲁棒；**非本机部署强烈建议设置** |
| `FM_MAX_UPLOAD_MB` | `100` | 单文件上限 |
| `FM_MAX_INLINE_MB` | `4` | MCP 内联返回内容的上限，超过则只给链接 |
| `FM_ALLOW_REMOTE_FETCH` | `1` | 是否允许 `url` 源上传 |
| `FM_ALLOW_LOCAL_PATH` | `1` | 是否允许 `path` 源上传 |
| `FM_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 保留与清理策略

- 每个文件写入时记录 `expiresAt = 上传时间 + 24 小时`。
- 三个时机会执行清理：服务启动时、每 10 分钟的守护任务、手动调用 `sweep_expired`。
- 另外，任何一次对已过期标识码的访问会返回 `410 expired` 并顺手删除该文件，不依赖守护任务的时序。
- 清理同时回收：到期文件实体 + 元数据、用尽/过期的上传票据、失去元数据的孤儿文件。
- 需要保留更久：上传时传 `ttlHours`，或事后调 `extend_expiry`；全局改默认值用 `FM_TTL_HOURS`。

## 项目结构

```
src/
  index.ts          启动入口（参数解析、传输选择、优雅退出）
  service.ts        全部业务逻辑（上传/下载/列表/延期/清理/统计）
  store.ts          元数据索引（串行写队列 + 临时文件原子 rename）
  storage.ts        文件实体存储（标识码命名，彻底隔绝路径穿越）
  codes.ts          标识码生成 / 归一化 / 展示格式
  retention.ts      24h 到期守护任务
  config.ts errors.ts logger.ts mime.ts utils.ts version.ts
  mcp/server.ts     9 个 MCP 工具定义
  http/app.ts       Express 路由 + 无状态 MCP 端点
  http/pages.ts     上传页面（无前端构建，自包含 HTML）
tests/service.test.ts
```

分层原则：`FileManagerService` 是唯一真相，MCP 层与 HTTP 层都只是它的薄封装，保证两边的标识码、链接与保留期行为完全一致。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（含“默认 24 小时”与清理行为的回归用例）
npm run build
```

## Docker

```bash
docker compose up -d --build
# 或
docker build -t mcp-file-manager . && docker run -p 8787:8787 -v "$PWD/data:/data" mcp-file-manager
```

## 安全提醒

- **标识码即凭证**：拿到标识码即可下载（无需 Token），分享链接前请确认接收方。标识码空间为 32^10，无法枚举。
- 对外暴露时请务必设置 `FM_API_TOKEN`，并在反代层加上 HTTPS 与频率限制。
- 如无需让 AI 读写服务器本地文件或抓取外网，请设 `FM_ALLOW_LOCAL_PATH=0`、`FM_ALLOW_REMOTE_FETCH=0`。
- 上传的原始文件名只保存在元数据里，磁盘上使用“标识码 + 白名单扩展名”命名。

## 后续可做

- 可插拔存储后端（S3 / R2）与预签名直传
- 多负载部署时把元数据换成 SQLite / Redis
- 可选的服务端加密与病毒扫描钩子
- 按上传者维度的配额与审计日志
