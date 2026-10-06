# MarkFlow

磁盘纯 `.md` 文件为唯一数据源的实时协同笔记系统。

- **双模解耦**：磁盘只存标准 Markdown；内存中是 CRDT 协同树（Yjs + Hocuspocus）
- **零厂商锁定**：随时用 `git`、`vim` 直接改服务器上的文件，在线页面自动同步
- **IPv6 优先双栈**：`::` 监听，IPv4/IPv6 均可浏览器直连，无需安装任何客户端
- **Typora 主题**：把 `.css` 丢进主题目录即可换装，同时作用于编辑与 PDF 导出
- **高保真 PDF**：服务端 Puppeteer 后台渲染，页眉页脚 + 分页控制

## 技术栈

React + Milkdown（所见即所得）· Yjs + Hocuspocus（协同）· Express + Chokidar（文件服务/监听）· Puppeteer（PDF）· pnpm workspaces monorepo（server / shared / web）

## Mac 本地开发

```bash
# 1. 启用 pnpm（Node ≥20 自带 corepack，无需全局安装）
corepack enable --install-directory ~/.local/bin

# 2. 安装依赖
pnpm install

# 3. 配置环境（首次）
cp .env.example .env

# 4. 同时启动后端(8080, 热重载)与前端(5173, Vite)
pnpm dev
```

打开 http://localhost:5173 ，默认账号 `admin / admin123`（见 `.env` 的 `AUTH_USERS`）。

开发模式说明：

- 前端经 Vite 代理访问 `/api` 与 `/collab` WebSocket，生产模式则由 Express 同端口直出
- 本地 PDF 导出需 `EXPORT_ORIGIN=http://localhost:5173`（.env 已带），让 Puppeteer 渲染 Vite 版导出页
- 运行测试：`pnpm test`（含路径穿越攻击向量、md⇄Yjs 往返、双端协同/防抖落盘/外部改动端到端）

## Ubuntu 生产部署（Docker Compose）

```bash
# 在服务器上（以 /data/notes 为笔记目录）
cd MarkFlow/docker
export JWT_SECRET=$(openssl rand -hex 32)
export AUTH_USERS="alice:她的密码,bob:他的密码"
export NOTES_DIR=/data/notes
export THEMES_DIR=/data/themes

docker compose up -d --build
```

容器内置 Chromium 与 Noto CJK 中文字体，PDF 导出开箱可用。

### IPv6 直连访问

- 常规 compose：Docker 在启用 IPv6 的守护进程上同时发布 `0.0.0.0` 与 `[::]`，
  局域网/公网 IPv6 直接 `http://[2001:db8::1]:8080` 访问
- 若 Docker 未启用 IPv6：改用 host 网络方案（服务直接监听宿主机双栈）
  ```bash
  docker compose -f docker-compose.host-net.yml up -d
  ```
  或给 Docker 守护进程开启 IPv6（`/etc/docker/daemon.json`）：
  ```json
  { "ipv6": true, "fixed-cidr-v6": "fd00:dead:beef::/64" }
  ```

### 跨架构镜像

Mac（arm64）上为 x86 服务器构建：

```bash
docker buildx build --platform linux/amd64 -t markflow:latest \
  -f docker/Dockerfile --push .   # 或 -o type=docker 导出 tar 后 scp
```

也可以直接把仓库传到服务器上 `docker compose up -d --build`（服务器本地构建）。

## 配置项（环境变量 / .env）

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `PORT` | `8080` | HTTP 与 WebSocket 共用端口 |
| `HOST` | `::` | 监听地址（`::` = IPv4/IPv6 双栈） |
| `NOTES_DIR` | `./data/notes` | Markdown 根目录（生产建议挂载卷） |
| `THEMES_DIR` | `./data/themes` | Typora CSS 主题目录 |
| `JWT_SECRET` | — | **生产必改**，`openssl rand -hex 32` |
| `AUTH_USERS` | `admin:admin123` | `用户名:密码` 逗号分隔；密码也可用 bcrypt 哈希 |
| `FLUSH_DEBOUNCE_WAIT_MS` | `1500` | 停止输入后多久落盘 |
| `FLUSH_DEBOUNCE_MAX_WAIT_MS` | `5000` | 连续输入时的最长落盘周期 |
| `WEB_DIST` | `./web/dist` | 前端产物目录（生产由 Express 托管） |
| `EXPORT_ORIGIN` | 同源 | 开发模式下导出页地址（指向 Vite） |

生成 bcrypt 密码哈希：`pnpm --filter @markflow/server run hash -- 你的密码`

## 日常使用

- **主题**：把 Typora 风格 `.css` 放进主题目录，刷新后右上角切换（内置 markflow-paper / markflow-night）
- **公式**：行内 `$E=mc^2$`，块级 `$$...$$`（MathJax 渲染，编辑时显示源码）
- **流程图**：\`\`\`mermaid 代码块（点击图表可回到源码编辑）
- **PDF**：右上角「导出 PDF」
- **外部编辑**：`vim` / `git pull` 保存后所有在线页面自动同步

## 安全

- 全部 API 与协同 WebSocket 需登录（JWT HttpOnly Cookie）
- 路径穿越防护：`..`、绝对路径、null byte、symlink 逃逸全部拦截（有攻击向量单测）
- 文件原子写盘（临时文件 + rename），外部读者永远看不到半个文件

## 仓库结构

```
server/   Express + Hocuspocus + Chokidar + Puppeteer
shared/   前后端共享的 Milkdown schema（md ⇄ Yjs 无头转换、数学节点、表格对齐）
web/      React + Vite + Milkdown 编辑器
docker/   Dockerfile 与 Compose（含 host 网络备选）
seeds/    首次启动播种的示例笔记与内置主题
```
