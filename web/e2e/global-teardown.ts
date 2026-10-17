import { cleanup } from './harness.ts'

export default async function globalTeardown(): Promise<void> {
  await cleanup()
}
