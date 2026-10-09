# MarkFlow

基于 **PostgreSQL 单存储** 的实时协同 Markdown 笔记系统：所见即所得编辑（Typora 观感）+ Yjs CRDT 多人协同 + 高保真 PDF 导出。

- **实时协同**：Yjs + Hocuspocus，多人同时编辑可见彼此彩色光标与选区；断线重连、离线送回均幂等合并
- **Typora 观感**：内置 markflow-paper / markflow-night 主题，把 Typora 风格 `.css` 丢进主题目录即可换装，同时作用于编辑与 PDF 导出
- **高保真 PDF**：服务端 Puppeteer 后台渲染——与页面排版逐字一致（断行/字体/主题完全相同）、侧边栏大纲书签、文档属性 Title；导出跟随当前所选主题
- **零厂商锁定**：随时「导出 MD」下载标准 Markdown 源文件；也支持从外部导入 Markdown 文档（重名自动编号）
- **丰富编辑体验**：Typora 风格快捷键、表格浮动工具栏、大纲/文件树折叠、任务列表点击勾选、编辑区独立缩放、真实进度加载动画
- **IPv6 优先双栈**：`::` 监听，IPv4/IPv6 均可浏览器直连，无需安装任何客户端

## 一键启动 / 停止（Mac 本地）

```bash
./start.sh   # 一键启动：Docker(PG) → 后端(8080) → 前端(5173)
./stop.sh    # 一键停止全部服务
```

启动后打开 <http://localhost:5173>，默认账号 `admin / admin123`（配置见 `AUTH_USERS`）。
局域网协作：同伴访问 `http://<你的IP>:5173`（启动日志会打印局域网地址）。

start.sh 会自动：拉起 Docker Desktop 与 PostgreSQL 容器（不存在则创建 `markflow-pg`）→
启动后端（Express + Hocuspocus，端口 8080）→ 启动前端（Vite，端口 5173）。

## 技术栈

React 19 + Milkdown 7（所见即所得，ProseMirror 内核）· Yjs + Hocuspocus v4（协同）·
Express（API + WebSocket 共端口）· PostgreSQL 17（唯一存储）· Puppeteer（PDF）·
pnpm workspaces monorepo（server / shared / web）

## Mac 开发模式

```bash
corepack enable --install-directory ~/.local/bin  # 启用 pnpm（Node ≥20）
pnpm install                                       # 安装依赖
cp .env.example .env                               # 首次配置
./start.sh                                         # 或 pnpm dev（后端热重载 + 前端 Vite）
```

开发说明：

- 前端经 Vite 代理访问 `/api` 与 `/collab` WebSocket；生产模式由 Express 同端口直出
- 本地 PDF 导出需 `EXPORT_ORIGIN=http://localhost:5173`（.env 已带），Puppeteer 渲染 Vite 版导出页
- PostgreSQL 连接串 `DATABASE_URL`（默认 `postgres://markflow:markflow@localhost:5432/markflow`，
  start.sh 创建的容器即此配置）

## 编辑功能速览

**快捷键**（完整版见应用内「快捷键手册.md」）：

| 操作 | macOS | Windows |
| --- | --- | --- |
| 标题 H1-H6 / 段落 | Cmd+1~6 / Cmd+0 | Ctrl+1~6 / Ctrl+0 |
| 标题升降级 | Cmd+= / Cmd+- | Ctrl+= / Ctrl+- |
| 代码块（块内再按取消） | Cmd+Option+K | Ctrl+Shift+K |
| 公式块 | Cmd+Shift+M | Ctrl+Shift+M |
| 行内代码 | Ctrl+\` 或 Cmd+E | Ctrl+Shift+\` |
| 无序 / 有序列表 | Cmd+Option+] / [ | Ctrl+Shift+] / [ |
| 任务列表 | Cmd+Option+9 | Ctrl+Alt+9 |
| 加粗 / 斜体（光标在格式区直接切换整段） | Cmd+B / Cmd+I | Ctrl+B / Ctrl+I |
| 块内 Cmd+A（代码/公式选块内容、表格选整表；再按全选文档） | Cmd+A | Ctrl+A |
| 编辑区缩放（只缩正文，UI 恒定，60%-200% 自动记忆） | Cmd+Shift+= / - / 0 | Ctrl+Shift+= / - / 0 |

**交互细节**（对齐 Typora）：

- **粘贴即渲染**：从外部粘贴带 Markdown 语法的纯文本直接解析成排版，普通中文文本不误伤
- **表格**：光标进入即出现浮动工具栏（对齐激活态高亮、行列增删、源码编辑、删除）——居中吸附、
  滚动/拖动/连续点击全程像素级稳定
- **任务列表**：点击 ☐/☑ 直接切换勾选（水平垂直居中对齐）
- **大纲**：标题层级折叠；点击跳转正文（按标题序号定位，重复标题也精确）
- **文件树**：目录折叠箭头
- **标题行首退格**：直接变普通段落；块首前置分隔线时退格一步删除
- **数学公式**：行内 `$E=mc^2$`、块级 `$$...$$`（MathJax 渲染）；兼容 Typora 宽松写法
  （单行 `$$公式$$`、开闭定界贴内容等，导入旧文档不再丢内容）
- **Mermaid**：语法错误时块内提示不炸版面；图表居中显示
- **代码块**：行号结构性对齐、语言输入、复制按钮；单击任意行光标直接落位（无需二次点击）
- **导入导出**：「导出 ▾」下拉（Markdown / PDF）；「导入」支持多选 .md 文件

## 存储：PostgreSQL（唯一后端）

数据全部落在 PostgreSQL：`files` 表（文件树）、`doc_state` 表（Yjs 二进制权威状态 +
Markdown 渲染缓存）、`revisions` 表（版本历史，为回滚预留）。编辑发生在 CRDT 内存树，
落库保留 CRDT 身份——重启后无损恢复，天然支持多实例横向扩展。

## 配置项（环境变量 / .env）

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `PORT` | `8080` | HTTP 与 WebSocket 共用端口 |
| `HOST` | `::` | 监听地址（`::` = IPv4/IPv6 双栈） |
| `DATABASE_URL` | `postgres://markflow:markflow@localhost:5432/markflow` | PostgreSQL 连接串 |
| `THEMES_DIR` | `./data/themes` | Typora CSS 主题目录 |
| `JWT_SECRET` | — | **生产必改**，`openssl rand -hex 32` |
| `AUTH_USERS` | `admin:admin123` | `用户名:密码` 逗号分隔；密码也可用 bcrypt 哈希 |
| `FLUSH_DEBOUNCE_WAIT_MS` | `1500` | 停止输入后多久落库 |
| `FLUSH_DEBOUNCE_MAX_WAIT_MS` | `5000` | 连续输入时的最长落库周期 |
| `WEB_DIST` | `./web/dist` | 前端产物目录（生产由 Express 托管） |
| `EXPORT_ORIGIN` | 同源 | 开发模式下导出页地址（指向 Vite） |

生成 bcrypt 密码哈希：`pnpm --filter @markflow/server run hash -- 你的密码`

## Ubuntu 生产部署

### 方式一：一键脚本（推荐）

```bash
git clone https://github.com/Kutbas/MarkFlow.git
cd MarkFlow && sudo bash deploy.sh
```

脚本自动完成：安装 Docker（缺失时）→ 拉取/更新代码 → 生成随机密钥
（`docker/.env`：JWT、数据库密码、admin 初始口令，仅首次生成）→
`docker compose up -d --build` → 等待 `/api/health` 就绪并打印访问信息。
**重复执行即为升级**（代码与镜像更新，`pgdata`/`themes` 数据卷保留）。

容器编排：`postgres` 带 healthcheck（`pg_isready`），应用容器
`depends_on: condition: service_healthy`——数据库就绪后才启动。
默认只监听 `127.0.0.1:8080`（配合反向代理对外）；需要局域网直连时
在 `docker/.env` 设 `BIND=0.0.0.0` 再 `docker compose up -d`。

### 方式二：手动 compose

```bash
cd MarkFlow/docker
export JWT_SECRET=$(openssl rand -hex 32)
export AUTH_USERS="alice:她的密码,bob:他的密码"

docker compose up -d --build
```

容器内置 Chromium 与 CJK 字体，PDF 导出开箱可用。若 Docker 未启用 IPv6，
改用 host 网络方案：`docker compose -f docker-compose.host-net.yml up -d`，
或按 `docker/` 内说明为守护进程开启 IPv6。

### 反向代理（1Panel / Nginx）要点

协同编辑走 WebSocket（`/collab`）、实时同步走 SSE（`/api/events`，后端已发
`X-Accel-Buffering: no`）。反代配置必须放行 WebSocket 升级，代理目标
`http://127.0.0.1:8080`。1Panel 操作步骤见仓库 `deploy.sh` 尾部提示或
项目文档。

跨架构构建（Mac arm64 → x86 服务器）：

```bash
docker buildx build --platform linux/amd64 -t markflow:latest \
  -f docker/Dockerfile --push .   # 或 -o type=docker 导出 tar 后 scp
```

## 安全

- 全部 API 与协同 WebSocket 需登录（JWT HttpOnly Cookie）
- 路径穿越防护：`..`、绝对路径、null byte、symlink 逃逸全部拦截（有攻击向量单测）
- 协同脏状态守卫：异常状态（空图片节点指纹）拒落库并广播重置

## 测试与覆盖率

```bash
pnpm test            # 全部 201 项测试（server 136 + web 65）
pnpm --filter @markflow/server test -- --coverage   # 覆盖率报告（含 shared 包）
```

server + shared（存储 / 协同引擎 / md⇄Yjs 转换 / 安全层 / 数学规范化）覆盖率由
`server/vitest.config.ts` 的 **90% 四维硬阈值**把关（不达标命令直接失败）。

web 的编辑器组件依赖真实 DOM 与协同连接，由浏览器实测兜底；纯逻辑层
（快捷键命令 / 列表守卫 / 表格操作 / 大纲折叠 / 缩放 / store / api client）为 jsdom 单测。

## Typora 主题兼容说明

把主题 `.css` 放入主题目录即可使用。MarkFlow 对 Typora 的常用约定做了兼容：

- `#write` 容器、`#write h2:before` 标题计数器、`@media print` 分页规则直接生效
- 代码块渲染带 `md-fences` 兼容类；公式渲染带 `md-math-block / md-math-inline`
- 任务列表以 `li[data-item-type=task]::before` 渲染 ☐/☑（可点击切换）

已实测：内置 markflow-paper / markflow-night，以及用户的 `latex.css`（LaTeX 论文风格，
标题编号、三线表、版心排版在编辑器与 PDF 导出中完整还原，断行逐字一致）。

## 仓库结构

```
server/   Express + Hocuspocus + Puppeteer（API / 协同 / 存储 / PDF 导出）
shared/   前后端共享的 Milkdown schema（md ⇄ Yjs 无头转换、数学节点、表格对齐、公式规范化）
web/      React + Vite + Milkdown 编辑器
docker/   Dockerfile 与 Compose（含 host 网络备选）
seeds/    首次启动播种的示例笔记与内置主题
data/     本地运行的 PostgreSQL 数据与主题目录
