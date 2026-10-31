import { dirname, join } from 'node:path'

/** 客户端固定使用默认数据目录，程序目录与它同在 ~/.baton 下。 */
export const programRoot = (dataDirectory: string) => join(dirname(dataDirectory), 'program')
