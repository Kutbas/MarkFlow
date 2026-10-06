/**
 * Node 无头环境的浏览器事件总线 shim。
 * @milkdown/ctx 的 Timer 使用全局 addEventListener/dispatchEvent/removeEventListener
 * （浏览器全局事件总线），Node 没有独立的这三个全局函数，用模块级 EventTarget 模拟。
 */
const bus = new EventTarget()
const g = globalThis as unknown as Record<string, unknown>

if (typeof g.dispatchEvent !== 'function') {
  g.addEventListener = bus.addEventListener.bind(bus)
  g.dispatchEvent = bus.dispatchEvent.bind(bus)
  g.removeEventListener = bus.removeEventListener.bind(bus)
}
