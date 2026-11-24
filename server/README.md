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
POST   /api/import/official     DeepSeek 官方历史 ZIP 导入
```

除 `/health` 外，如果设置了 `REMOTE_STORAGE_TOKEN`，请求必须带：

```http
Authorization: Bearer <token>
```

## 导入 DeepSeek 官方历史 ZIP

服务端可以直接导入官方导出的聊天记录 ZIP：

```bash
curl -X POST \
  -H "Authorization: Bearer <你的Token>" \
  -H "Content-Type: application/zip" \
  --data-binary @deepseek_data-2026-01-01.zip \
  https://storage.example.com/api/import/official
```

返回示例：

```json
{
  "ok": true,
  "sessions": 12,
  "files": 34,
  "entries": 58
}
```

导入后：

- 会话写入 `DATA_DIR/sessions/*.json`
- 图片附件写入 `DATA_DIR/files/*`
- 前端下次「立即同步」或刷新时即可拉取

支持官方格式：

```text
export_format_version: 3
```

不支持 ZIP64、加密 ZIP、分卷 ZIP。

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


## Docker 部署

`server/` 目录中包含：

```text
Dockerfile
docker-compose.yml
```

### 1. 准备环境变量

```bash
cd server
cat > .env <<'EOF'
REMOTE_STORAGE_TOKEN=请替换成强随机Token
CORS_ORIGIN=https://go.wu-pretend.top
EOF
```

### 2. 启动

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

### 3. 数据持久化

docker-compose 默认使用 named volume：

```text
chat-demo-data
```

备份：

```bash
docker run --rm \
  -v chat-demo-storage_chat-demo-data:/data \
  -v "$PWD:/backup" \
  alpine tar czf /backup/chat-demo-data.tar.gz -C /data .
```

> 卷名前缀取决于 compose project 名，可用 `docker volume ls` 查看。

### 4. 国内服务器拉取镜像

如果 Docker Hub 访问慢，给 Docker 配置阿里云镜像加速器：

```json
{
  "registry-mirrors": ["https://<你的ID>.mirror.aliyuncs.com"]
}
```

写入 `/etc/docker/daemon.json` 后重启 Docker：

```bash
sudo systemctl restart docker
```

## 原生 systemd 部署

如果不使用 Docker，可以把 `index.mjs` 复制到服务器，用 systemd 托管：

```bash
sudo mkdir -p /opt/chat-demo-storage /srv/chat-demo-data
sudo cp index.mjs import-official.mjs /opt/chat-demo-storage/
sudo useradd --system --home /opt/chat-demo-storage --shell /usr/sbin/nologin chatdemo || true
sudo chown -R chatdemo:chatdemo /opt/chat-demo-storage /srv/chat-demo-data
```

复制并修改：

```text
deploy/chat-demo-storage.service
```

到：

```text
/etc/systemd/system/chat-demo-storage.service
```

修改其中的：

```text
REMOTE_STORAGE_TOKEN
CORS_ORIGIN
```

然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chat-demo-storage
sudo systemctl status chat-demo-storage
```

## Nginx 反向代理

参考：

```text
deploy/nginx.conf.example
```

重点：

- 只监听 `127.0.0.1:8787`
- 对公网只暴露 `443`
- `client_max_body_size` 至少 128m
- 使用 HTTPS 证书

## 更新服务

Docker：

```bash
docker compose up -d --build
```

systemd：

```bash
sudo systemctl restart chat-demo-storage
```
