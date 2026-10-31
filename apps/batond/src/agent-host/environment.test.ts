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

it('passes certificate and proxy variables unchanged to every Agent', () => {
  const network = {
    NODE_EXTRA_CA_CERTS: '/certs/extra.pem',
    SSL_CERT_FILE: '/certs/ca.pem',
    SSL_CERT_DIR: '/certs',
    HTTP_PROXY: 'http://proxy:8080',
    HTTPS_PROXY: 'http://proxy:8081',
    ALL_PROXY: 'socks5://proxy:1080',
    NO_PROXY: 'localhost,.example.com',
    http_proxy: 'http://proxy:8082',
    https_proxy: 'http://proxy:8083',
    all_proxy: 'socks5://proxy:1081',
    no_proxy: '',
  }
  const expected = { ...network, NODE_USE_ENV_PROXY: '1' }
  if (process.platform === 'win32') {
    delete (expected as Partial<typeof expected>).HTTP_PROXY
    delete (expected as Partial<typeof expected>).HTTPS_PROXY
    delete (expected as Partial<typeof expected>).ALL_PROXY
    delete (expected as Partial<typeof expected>).NO_PROXY
  }
  for (const agent of ['cursor', 'pi', 'codex', 'kiro', 'antigravity']) {
    expect(
      agentEnvironment(agent, { ...network, OPENAI_API_KEY: 'secret', NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    ).toEqual(expected)
  }
})

it('passes the account directory only to the Agent that reads it', () => {
  const source = {
    PATH: '/usr/bin',
    USER: 'employee',
    LOGNAME: 'employee',
    SHELL: '/bin/zsh',
    PI_CODING_AGENT_DIR: '/pi',
    PI_CODING_AGENT_SESSION_DIR: '/pi/sessions',
    CODEX_HOME: '/codex',
    CURSOR_API_KEY: 'cursor-key',
    OPENAI_API_KEY: 'other-provider-key',
  }
  expect(agentEnvironment('pi', source)).toEqual({
    PATH: '/usr/bin',
    USER: 'employee',
    LOGNAME: 'employee',
    SHELL: '/bin/zsh',
    PI_CODING_AGENT_DIR: '/pi',
    PI_CODING_AGENT_SESSION_DIR: '/pi/sessions',
  })
  expect(agentEnvironment('codex', source)).toEqual({
    PATH: '/usr/bin',
    USER: 'employee',
    LOGNAME: 'employee',
    SHELL: '/bin/zsh',
    CODEX_HOME: '/codex',
  })
})
