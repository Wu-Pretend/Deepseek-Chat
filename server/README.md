# chat-demo external storage server

一个零依赖的 Node.js 存储服务，供 chat-demo 前端保存会话和附件。

## 启动

```bash
# 在 chat-demo 根目录
npm run server
```

默认监听：

```text
http://127.0.0.1:8787
```

数据保存在 `./data/`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REMOTE_STORAGE_HOST` | `127.0.0.1` | 监听地址，局域网使用可设为 `0.0.0.0` |
| `REMOTE_STORAGE_PORT` | `8787` | 监听端口 |
| `REMOTE_STORAGE_TOKEN` | 空 | 可选 Bearer Token |
| `DATA_DIR` | `./data` | 数据目录 |
| `CORS_ORIGIN` | `*` | 允许的前端来源 |

示例：

```bash
REMOTE_STORAGE_HOST=0.0.0.0 \
REMOTE_STORAGE_PORT=8787 \
REMOTE_STORAGE_TOKEN='change-me' \
DATA_DIR=/srv/chat-demo-data \
npm run server
```

## API

```text
GET    /health
GET    /api/sessions
GET    /api/sessions/:id
PUT    /api/sessions/:id
PATCH  /api/sessions/:id       body: {"title":"..."}
DELETE /api/sessions/:id
GET    /api/files/:id
PUT    /api/files/:id
DELETE /api/files/:id
GET    /api/tombstones
DELETE /api/all
```

除 `/health` 外，如果设置了 `REMOTE_STORAGE_TOKEN`，请求必须带：

```http
Authorization: Bearer <token>
```

## 部署

可以把 `server/` 目录单独复制到服务器，或者用 systemd / Docker 托管：

```bash
node server/index.mjs
```

建议：

- 放在 HTTPS 反向代理后面
- 设置强随机 `REMOTE_STORAGE_TOKEN`
- 定期备份 `DATA_DIR`
- 不要直接把数据目录暴露为静态目录

## GitHub Pages + 阿里云部署

前端可以放在 GitHub Pages，后端存储服务放在阿里云 ECS / Function Compute：

1. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 中新建：
   - `REMOTE_STORAGE_URL=https://storage.example.com`
2. 把 `server/` 部署到阿里云，设置：
   ```bash
   REMOTE_STORAGE_HOST=0.0.0.0
   REMOTE_STORAGE_PORT=8787
   REMOTE_STORAGE_TOKEN='strong-random-token'
   DATA_DIR=/srv/chat-demo-data
   CORS_ORIGIN=https://<你的GitHub用户名>.github.io
   ```
3. 用 Nginx / Caddy / 阿里云负载均衡给存储服务配 HTTPS。
4. 在页面「设置 → 数据管理 → 外部存储」里填写同一个 HTTPS 地址和 Token。

注意：

- GitHub Pages 是 HTTPS，所以外部存储地址也必须是 HTTPS，否则浏览器会拦截混合内容。
- `REMOTE_STORAGE_TOKEN` 只放在阿里云服务端和浏览器设置里，不进入 GitHub 仓库。
- API Key 只保存在浏览器 `localStorage`，不会写入同步的会话数据或外部存储服务。
