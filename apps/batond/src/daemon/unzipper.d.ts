declare module 'unzipper' {
  import type { Readable } from 'node:stream'
  interface Entry {
    path: string
    type: 'File' | 'Directory'
    uncompressedSize: number
    externalFileAttributes: number
    flags: number
    stream(): Readable
  }
  export const Open: { file(path: string): Promise<{ files: Entry[] }> }
}
