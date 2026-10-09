# 欢迎使用 MarkFlow

MarkFlow 是一个基于 **PostgreSQL 存储**的实时协同笔记系统：所有内容以标准 Markdown 保存在数据库中，编辑发生在内存的 CRDT 协同树中，随时可以导出为 `.md` 文件。

> 核心理念：**零厂商锁定**。随时可以把笔记导出为标准 Markdown 文件，用 `git`、`vim` 或任何工具继续编辑与归档。

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
    B -->|防抖 1.5s| C[(PostgreSQL 权威状态)]
    C -->|SSE 广播| D[在线页面同步]
```

---

## 开始吧

1. 左侧文件树可以新建/重命名/移动/删除文件
2. 光标移开的瞬间，Markdown 标记会自动隐去——这就是 Typora 式所见即所得
3. 多人同时编辑时，能看到彼此的彩色光标和选区
