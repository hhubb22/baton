import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vite-plus/test'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// jsdom 没有实现滚动，路由切换时会调用它。
window.scrollTo = () => {}

// jsdom 没有 ResizeObserver 和 document.fonts，输入区测量行高时会用到。
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true })

// jsdom 不计算布局，选区菜单定位时读取的选区矩形一律为空。
Range.prototype.getBoundingClientRect = () => new DOMRect()
