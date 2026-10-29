import { highlightCode } from './highlight-code'

self.onmessage = (event: MessageEvent<{ id: number; content: string; path: string; theme: 'light' | 'dark' }>) => {
  const { id, content, path, theme } = event.data
  void highlightCode(content, path, theme).then(
    (lines) => self.postMessage({ id, lines }),
    () => self.postMessage({ id, lines: null }),
  )
}
