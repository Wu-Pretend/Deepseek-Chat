# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 模型选择（DeepSeek Flash / DeepSeek V4 Pro）、思考强度设置、安全审查等级与拒绝撤回开关、账户余额查询。
- 侧边栏展开/收起、移动端抽屉滑入动画。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 外部存储（可选）

默认情况下会话保存在浏览器 IndexedDB。要跨设备同步，可以启动仓库自带的零依赖存储服务：

```sh
npm run server
```

默认监听 `http://127.0.0.1:8787`，数据写在 `./data/`。服务端配置见 [server/README.md](server/README.md)。

前端有两种配置方式：

1. 构建时注入默认地址：

```sh
REMOTE_STORAGE_URL=http://127.0.0.1:8787 npm run dev
```

2. 运行时在「设置 → 数据管理 → 外部存储」中填写服务器地址和可选 Token。

启用后，应用启动时会从外部服务器拉取会话列表，并按设置预取最近 N 个完整会话及其附件（默认 1，网络慢时可设为 0）；更早的会话先显示摘要，打开时再按需下载。本地较新的会话会推送到服务器，保存、重命名、删除也会镜像过去。冲突策略是按会话 `updatedAt` 的 last-write-wins。

> 同步中断后可以直接再次点击「立即同步」：已经保存到本地 IndexedDB 的会话不会重复下载，正在下载但尚未完成的会话会重试。

服务端也支持直接导入 DeepSeek 官方历史记录 ZIP：

```bash
curl -X POST \
  -H "Authorization: Bearer <Token>" \
  -H "Content-Type: application/zip" \
  --data-binary @deepseek_data.zip \
  https://storage.example.com/api/import/official
```

导入后前端点击「立即同步」即可拉取。

## 数据

API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
