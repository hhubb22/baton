import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'
import { createMockClient } from '../data/mock/client'
import { manualScheduler } from '../data/mock/scheduler'
import { ArchivedNotice } from './ProjectSettings'

async function data() {
  const client = createMockClient('normal', { scheduler: manualScheduler() })
  const project = (await client.listProjects()).find((item) => item.id === 'prj-baton')!
  const thread = (await client.listThreads()).find((item) => item.id === 'thr-gateway')!
  const devices = await client.listDevices()
  return { project: { ...project, status: 'archived' as const }, thread, devices }
}

describe('archived project notice', () => {
  it('says a thread could not stop when the device did not carry out the stop', async () => {
    const { project, thread, devices } = await data()
    render(
      <ArchivedNotice project={project} threads={[{ ...thread, pending: null, stopFailed: true }]} devices={devices} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('只读。1 个对话停止失败，请打开后重试。')
  })

  it('says a thread is still running when no stop is on its way', async () => {
    const { project, thread, devices } = await data()
    render(<ArchivedNotice project={project} threads={[{ ...thread, pending: null }]} devices={devices} />)
    expect(screen.getByRole('status')).toHaveTextContent('只读。1 个对话仍在运行，请打开后停止。')
  })

  it('names the assistant device while the assistant is still stopping', async () => {
    const { project, thread, devices } = await data()
    render(
      <ArchivedNotice
        project={{ ...project, agent: { ...project.agent, state: 'stopping', deviceId: 'dev-ubuntu' } }}
        threads={[{ ...thread, status: 'stopped', pending: null }]}
        devices={devices}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('只读。等待 Ubuntu Dev 停止助手。')
  })
})
