import { expect, it } from 'vite-plus/test'
import { agentEnvironment } from './environment.ts'

it('passes only runtime essentials and the Agent own configuration', () => {
  const env = agentEnvironment('cursor', {
    PATH: '/usr/bin',
    HOME: '/home/employee',
    LANG: 'en_US.UTF-8',
    CURSOR_API_KEY: 'cursor-key',
    OPENAI_API_KEY: 'other-provider-key',
    XAI_API_KEY: 'other-provider-key',
    BATON_PROJECT_RUNTIME_TOKEN: 'runtime-token',
    NODE_OPTIONS: '--inspect',
  })
  expect(env).toEqual({
    PATH: '/usr/bin',
    HOME: '/home/employee',
    LANG: 'en_US.UTF-8',
    CURSOR_API_KEY: 'cursor-key',
  })
})

it('keeps another Agent from seeing the Cursor key', () => {
  expect(agentEnvironment('shell', { PATH: '/usr/bin', CURSOR_API_KEY: 'cursor-key' })).toEqual({ PATH: '/usr/bin' })
})
