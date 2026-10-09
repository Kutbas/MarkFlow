import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initZoom } from './zoom'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import './styles/global.css'

// 不用 StrictMode：其开发模式双挂载与 Milkdown 编辑器生命周期冲突
initZoom()
createRoot(document.getElementById('root')!).render(<App />)
