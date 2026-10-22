import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// jsdom 没有实现滚动，路由切换时会调用它。
window.scrollTo = () => {}

// jsdom 不计算布局，选区菜单定位时读取的选区矩形一律为空。
Range.prototype.getBoundingClientRect = () => new DOMRect()
