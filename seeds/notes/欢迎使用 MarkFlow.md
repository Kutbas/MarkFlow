# 欢迎使用 MarkFlow

MarkFlow 是一个以**磁盘纯 `.md` 文件为唯一数据源**的实时协同笔记系统：磁盘上永远是标准 Markdown，编辑发生在内存的 CRDT 协同树中。

> 核心理念：**零厂商锁定**。随时可以用 `git`、`vim` 或任何工具直接改这些文件，MarkFlow 会自动感知并同步到所有在线页面。

## 扩展语法演示

### GFM 表格

| 功能 | 技术选型 | 状态 |
| ---- | -------- | ---- |
| 实时协同 | Yjs + Hocuspocus | ✅ |
| 所见即所得 | Milkdown | ✅ |
| PDF 导出 | Puppeteer | ✅ |

### 任务列表

- [x] 阅读这篇欢迎文档
- [ ] 打开右上角主题选择器换个皮肤
- [ ] 试试 `$$` 公式块和 Mermaid 流程图
- [ ] 邀请同伴用另一个浏览器打开同一篇文档

### 代码高亮

```ts
// 实时协同的最小示例
import * as Y from 'yjs'

const doc = new Y.Doc()
doc.getText('content').insert(0, '你好，MarkFlow')
```

### 数学公式

质能方程 $E = mc^2$ 是行内公式，下面是公式块：

$$
\int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}
$$

### Mermaid 流程图

```mermaid
graph LR
    A[浏览器编辑] -->|CRDT 增量| B((内存协同树))
    B -->|防抖 1.5s| C[磁盘 .md 文件]
    C -->|Chokidar 监听| D[外部改动广播]
```

---

## 开始吧

1. 左侧文件树可以新建/重命名/移动/删除文件
2. 光标移开的瞬间，Markdown 标记会自动隐去——这就是 Typora 式所见即所得
3. 多人同时编辑时，能看到彼此的彩色光标和选区
