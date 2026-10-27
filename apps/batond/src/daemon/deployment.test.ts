import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { loadDeployment } from './deployment.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('loads deployment only from an installation directory and tolerates a missing file', async () => {
  const directory = await makePrivateTempDirectory('baton-deployment-')
  temporary.push(directory)
  expect(await loadDeployment(directory)).toBeUndefined()
  const deployment = { format: 1, coordinator_url: 'https://center.invalid:8443', ca_pem: 'offline-ca' }
  await writeFile(join(directory, 'deployment.json'), JSON.stringify(deployment))
  expect(await loadDeployment(directory)).toEqual(deployment)
  expect(await loadDeployment()).toBeUndefined()
})

it.each([
  '{invalid',
  JSON.stringify({ format: 2, coordinator_url: 'https://center.invalid' }),
  JSON.stringify({ format: 1, coordinator_url: 'http://center.invalid' }),
  JSON.stringify({ format: 1, coordinator_url: 'https://center.invalid/path' }),
  JSON.stringify({ format: 1, coordinator_url: 'https://user:password@center.invalid' }),
  JSON.stringify({ format: 1, coordinator_url: 'https://center.invalid', ca_pem: 123 }),
])('rejects invalid deployment without echoing its contents: %s', async (raw) => {
  const directory = await makePrivateTempDirectory('baton-deployment-')
  temporary.push(directory)
  await writeFile(join(directory, 'deployment.json'), raw)
  await expect(loadDeployment(directory)).rejects.toMatchObject({ code: 'deployment_invalid' })
})
