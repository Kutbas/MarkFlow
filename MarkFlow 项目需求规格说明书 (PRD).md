# MarkFlow 项目需求规格说明书 (PRD)

## 系统定位与设计理念

1. **双模解耦**：磁盘只存储纯 `.md` 文件及文件夹结构；内存与网络传输层处理 CRDT 实时协同数据流。
2. **零厂商锁定 (Zero Lock-in)**：服务端去数据库化，外部可以直接在服务器磁盘上修改文件（如通过 `git`、`vim` 或 SSH），系统能自动感知并广播。
3. **全网段直连 (IPv6-First)**：原生支持 IPv4 / IPv6 双栈网络架构，在没有公网 IPv4 的环境下，只需输入 IPv6 地址即可通过浏览器直连访问。
4. **即开即用 (Zero Client Install)**：跨平台（Mac/Windows）统一通过现代化浏览器访问，无需在电脑本地安装任何客户端。
5. **本地开发至生产平滑迁移**：采用“Mac 本地开发调试 ➔ Docker 容器化打包 ➔ Ubuntu 服务器一键部署”的标准化工程流水线，保障开发与生产环境高度一致。

## 详细需求规格说明

### 文件管理与服务器监听 (File System Engine)

- **原生目录挂载**：系统直接绑定并映射指定的硬盘路径（Mac 本地开发路径或 Ubuntu 服务器路径，如 `/data/notes`），严格按原样呈现文件和文件夹的树状层级。
- **文件增删改查 (CRUD)**：支持在 Web 端进行文件及子文件夹的创建、重命名、移动和删除。
- **服务器文件变动监听 (File Watcher)**：后端集成文件监听机制。当磁盘上的 `.md` 文件被外部程序（如 Git 提交、命令行 Vim 编辑等）修改时，服务端能实时捕获改动并通知所有在线页面进行同步，防止覆盖外部修改。
- **安全路径校验**：对所有前端提交的文件路径进行严格校验，阻断路径穿越攻击（Path Traversal Guard），防止访问授权目录之外的服务器文件。

### 实时协同与并发控制 (Real-time Collaboration Engine)

- **CRDT 协同合并**：采用基于 Yjs 的 CRDT（无冲突可复制数据类型）算法，支持多人在不同电脑或浏览器上同时打开并编辑同一篇文档。改动在毫秒级自动平滑合并，彻底解决“后保存覆盖先保存”的数据覆盖冲突。
- **感知与光标定位 (Awareness & Cursors)**：在文档编辑区域实时高亮显示其他协同者的头像、用户名、当前光标所在位置以及选中的文本区域。
- **内存协同与防抖落盘 (Debounced Disk Flush)**：
  - **内存层**：所有实时编辑操作在服务端的内存协同树中完成无冲突合并。
  - **磁盘层**：服务端配备防抖落盘机制，当用户停止输入达到 1.5 秒（或达到设定的 5 秒固定周期）时，自动将内存中最新的协同状态导出为标准纯 `.md` 文本并覆写回磁盘。

### 编辑器、Typora 主题与高保真 PDF 导出 (Editor & Export Engine)

- **Typora 风格所见即所得**：编辑器采用即时渲染模式（WYSIWYG），在编辑时隐去 Markdown 标记符号，光标移开即呈现排版效果。
- **扩展 Markdown 语法**：完整支持 GFM 表格、任务列表、代码高亮、MathJax 数学公式、Mermaid 流程图以及脚手架与注脚。
- **Typora CSS 主题一键注入**：支持用户将自定义的 Typora `.css` 主题文件上传或放置在指定目录。Web 前端可动态读取并加载这些 CSS 文件，直接应用到编辑和预览容器中，100% 复刻 Typora 的视觉排版与字体风格。
- **高保真 PDF 导出引擎**：在服务端后台运行无头浏览器（Puppeteer）。当用户点击“导出 PDF”时，服务端后台渲染包含当前 Typora CSS 主题的页面，并将其精确转换为包含分页控制、页眉页脚的高清 PDF 文件供用户下载。

### 原生 IPv6 与网络架构 (Networking & IPv6)

- **双栈套接字监听 (Dual-Stack Listening)**：服务端 HTTP 与 WebSocket 服务统一绑定至 IPv6 全零监听地址（`::`）。在支持双栈的操作系统内核中，该模式会自动兼顾 IPv4 与 IPv6 的入站连接请求。
- **IPv6 地址兼容**：系统的跨域策略（CORS）、Host 请求头校验以及 WebSocket 握手逻辑，全面兼容包含方括号的 IPv6 URL 格式（例如 `[http://[2001:db8::1]:8080](http://[2001:db8::1]:8080)`）。
- **容器化 IPv6 端口映射**：部署配置文件提供专门的端口映射规则，将宿主机的 IPv6 接口直接透传映射至容器服务端口。

### 开发、测试与部署工程流程 (Dev, Testing & Deployment Lifecycle)

- **Mac 本地开发与测试**：
  - **本地运行**：在 macOS 环境下直接启动热重载开发服务器，挂载 Mac 本地测试文件夹，快速验证 Markdown 编辑、Yjs 实时协同以及 Typora CSS 主题加载逻辑。
  - **依赖隔离测试**：在 Mac 本地优先通过 Docker 容器运行环境测试 Puppeteer (Chromium) 依赖与 Node.js 双栈监听逻辑，避免“本地能跑但容器里缺少无头浏览器字体/依赖”的问题。
- **Ubuntu Docker 生产部署**：
  - **一键容器化部署**：完成测试后，将全量服务打包为标准 Docker 镜像，通过 Docker Compose 在 Ubuntu 服务器上一键部署运行。
  - **持久化卷映射 (Volume Mounting)**：通过 Docker 卷将 Ubuntu 宿主机的纯 Markdown 目录（如 `/data/notes`）与 Typora 主题目录挂载至容器内部，确保容器销毁或更新时 Markdown 文件绝对安全。

### 系统安全性与数据可用性 (Security & Reliability)

- **轻量鉴权**：提供基于 Cookie / JWT 的身份验证机制，防止未授权访问。
- **数据防锁死 (Zero Data Lock)**：即使系统服务彻底停止，服务器磁盘上的所有数据依然是结构清晰、随时可用标准工具读取的 `.md` 文件。

## 单一推荐技术架构选型

| **架构层级**                 | **技术选型**                | **选用理由**                                                 |
| ---------------------------- | --------------------------- | ------------------------------------------------------------ |
| **前端框架**                 | **React**                   | 生态极度成熟，与 ProseMirror/Milkdown 及 Yjs 协同插件的结合度最好。 |
| **Markdown 编辑器**          | **Milkdown**                | 基于 ProseMirror 的插件化编辑器，原生支持 Typora 风格的所见即所得渲染，且完美支持动态注入自定义 CSS 样式表。 |
| **协同引擎 (客户端/服务端)** | **Yjs + Hocuspocus**        | **Yjs** 是 Web 协同领域的绝对标杆；**Hocuspocus** 是针对 Yjs 封装的开箱即用 Node.js 服务端，提供了完美的文档加载与防抖落盘生命周期钩子。 |
| **服务端基础框架**           | **Node.js (Express)**       | 极易实现 IPv6 双栈套接字监听，且与 Puppeteer、Hocuspocus 和 Chokidar 同属 JS 生态，无跨语言调用的性能损耗与协议调试成本。 |
| **磁盘文件监听**             | **Chokidar**                | Node.js 领域最稳定、占用资源最低的磁盘文件监听库。           |
| **PDF 渲染导出引擎**         | **Puppeteer**               | 基于真实 Chromium 引擎后台渲染 HTML+CSS，导出 PDF 的还原度最高。 |
| **部署与交付容器**           | **Docker + Docker Compose** | 彻底消除 macOS 开发环境与 Ubuntu 生产环境的底层差异，完美解决 Puppeteer 无头浏览器在 Linux 环境下的依赖与字体配置。 |

## 全生命周期运作流程

1. **Mac 开发测试阶段**：在 Mac 上编写 React 前端与 Node.js 后端应用 ➔ 挂载 Mac 本地 Markdown 文件夹进行热重载功能调试 ➔ 在 Mac 上使用 Docker 验证 Puppeteer PDF 生成与双栈 WebSocket 连接 ➔ 确认功能和测试全数通过。
2. **Ubuntu 生产部署阶段**：将应用代码与环境配置整理为 Docker Compose 描述文件 ➔ 推送镜像至 Ubuntu 服务器 ➔ 在 Ubuntu 上指定挂载宿主机 Markdown 路径（如 `/data/notes`）并启动 Docker 容器。
3. **日常读取与协同流程**：多台 Mac 和 Windows 打开浏览器（通过 IPv4 或 IPv6 地址）访问 Ubuntu 部署的服务 ➔ Hocuspocus 触发加载钩子，Chokidar 读取 Ubuntu 磁盘上的 `.md` 文件 ➔ 转化为 Yjs 内存协同树 ➔ 通过 WebSocket 推送到前端 Milkdown 编辑器渲染。
4. **实时保存与落盘流程**：多端协同修改文档，改动在内存中平滑合并 ➔ 用户停止输入 1.5 秒后，Hocuspocus 自动触发落盘钩子 ➔ 将最新内容序列化为纯 `.md` 文本写入 Ubuntu 宿主机磁盘。