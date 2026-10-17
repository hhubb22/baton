import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Enrollment, NodeStatus } from '../types.ts'
import { deskId, laptopId, listOf, node, saved } from '../test/fixtures.ts'
import { DefaultPCForm } from './DefaultPCForm.tsx'
import { EnrollmentPanel } from './EnrollmentPanel.tsx'
import { NodeCard } from './NodeCard.tsx'

const notice = '吊销连接凭据不会停止离线节点上的本地进程。重新接入需要新的连接凭据。'

function deskNode(partial: Partial<NodeStatus> = {}): NodeStatus {
  return node({
    id: deskId,
    display_name: 'Desk',
    capabilities: ['start', 'input'],
    registration_seq: 1,
    ...partial,
  })
}

describe('节点卡片', () => {
  it('离线节点显示最后报告，不把它当成当前在线', () => {
    render(
      <NodeCard
        node={deskNode({
          online: false,
          synced: false,
          executable: false,
          last_contact_at: '2026-10-17T01:02:03Z',
          status_updated_at: '2026-10-17T01:02:04Z',
        })}
        notice={notice}
        canWrite
        busy={false}
        onRevoke={vi.fn()}
      />,
    )
    expect(screen.getByTestId('node-presence')).toHaveTextContent('离线')
    expect(screen.getByTestId('node-last-contact')).toHaveTextContent('最后报告于')
    expect(screen.getByTestId('node-last-contact')).not.toHaveTextContent('尚未报告')
    expect(screen.getByText('这是中心保存的最后一次报告，不代表节点现在仍在线。')).toBeInTheDocument()
    expect(screen.getByTestId('node-sync')).toHaveTextContent('尚未同步')
    expect(screen.getByTestId('node-executable')).toHaveTextContent('不可执行')
    expect(screen.getByTestId('node-capabilities')).toHaveTextContent('start')
    expect(screen.getByTestId('node-capabilities')).toHaveTextContent('input')
  })

  it('吊销处理中和已生效使用各自的服务端状态', async () => {
    const user = userEvent.setup()
    const onRevoke = vi.fn()
    const { rerender } = render(
      <NodeCard node={deskNode()} notice={notice} canWrite busy={false} onRevoke={onRevoke} />,
    )
    await user.click(screen.getByTestId('revoke-open'))
    expect(screen.queryByText('已生效')).not.toBeInTheDocument()
    rerender(<NodeCard node={deskNode()} notice={notice} canWrite busy onRevoke={onRevoke} />)
    expect(screen.getByTestId('revoke-confirm')).toHaveTextContent('正在提交')
    rerender(<NodeCard node={deskNode()} notice={notice} canWrite busy={false} onRevoke={onRevoke} />)
    await user.click(screen.getByTestId('revoke-confirm'))
    expect(onRevoke).toHaveBeenCalledWith(deskId)

    rerender(
      <NodeCard
        node={deskNode({
          revocation_status: 'pending',
          executable: false,
          revocation: {
            status: 'pending',
            operator_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            credential_ids: [],
            requested_at: '2026-10-17T00:00:00Z',
            applied_at: null,
            message: '吊销正在处理，尚未生效。',
            local_process_notice: notice,
          },
        })}
        notice={notice}
        canWrite
        busy={false}
        onRevoke={onRevoke}
      />,
    )
    const pending = screen.getByTestId('revoke-status')
    expect(pending).toHaveAttribute('data-status', 'pending')
    expect(pending).toHaveTextContent('处理中')
    expect(pending).toHaveTextContent('尚未生效')
    expect(pending).toHaveTextContent('不会停止')
    expect(pending).not.toHaveTextContent('已生效')

    rerender(
      <NodeCard
        node={deskNode({
          revocation_status: 'effective',
          executable: false,
          revocation: {
            status: 'effective',
            operator_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            credential_ids: [],
            requested_at: '2026-10-17T00:00:00Z',
            applied_at: '2026-10-17T00:00:02Z',
            message: '吊销已生效。同一连接凭据不能再连接。',
            local_process_notice: notice,
          },
        })}
        notice={notice}
        canWrite
        busy={false}
        onRevoke={onRevoke}
      />,
    )
    const done = screen.getByTestId('revoke-status')
    expect(done).toHaveAttribute('data-status', 'effective')
    expect(done).toHaveTextContent('已生效')
    expect(done).toHaveTextContent('不会停止')
    expect(done).not.toHaveTextContent('处理中')
  })
})

describe('默认 PC', () => {
  it('默认节点失效时不自动改选', () => {
    const list = listOf([
      node({ id: deskId, display_name: 'Desk', revocation_status: 'effective' }),
      node({ id: laptopId, display_name: 'Laptop' }),
    ], deskId, true)
    render(<DefaultPCForm list={list} saved={null} canWrite busy={false} onSave={vi.fn()} />)
    expect(screen.getByTestId('default-pc-select')).toHaveValue('')
    expect(screen.getByTestId('default-pc-current')).toHaveTextContent(deskId)
    expect(screen.getByTestId('default-pc-current')).not.toHaveTextContent('Laptop')
    expect(screen.getByTestId('default-pc-invalid')).toHaveTextContent('需要重新选择')
  })

  it('展示响应里保存的节点，并允许选择离线节点', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const list = listOf([
      node({ id: deskId, display_name: 'Desk', online: true }),
      node({ id: laptopId, display_name: 'Laptop', online: false }),
    ], deskId)
    const { rerender } = render(<DefaultPCForm list={list} saved={null} canWrite busy={false} onSave={onSave} />)
    await user.selectOptions(screen.getByTestId('default-pc-select'), laptopId)
    expect(screen.getByTestId('default-pc-offline')).toBeInTheDocument()
    expect(screen.getByTestId('default-pc-current')).toHaveTextContent(deskId)
    await user.click(screen.getByTestId('default-pc-save'))
    expect(onSave).toHaveBeenCalledWith(laptopId)
    const actual = saved(deskId, 'Desk From Server', 9)
    rerender(<DefaultPCForm list={list} saved={actual} canWrite busy={false} onSave={onSave} />)
    expect(screen.getByTestId('default-pc-saved')).toHaveTextContent('Desk From Server')
    expect(screen.getByTestId('default-pc-saved')).toHaveTextContent(deskId)
    expect(screen.getByTestId('default-pc-saved')).not.toHaveTextContent('Laptop')
  })

  it('已选节点失效后清空选择，不改派到其他节点', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const list = listOf([
      node({ id: deskId, display_name: 'Desk', online: true }),
      node({ id: laptopId, display_name: 'Laptop', online: false }),
    ], laptopId)
    const { rerender } = render(<DefaultPCForm list={list} saved={null} canWrite busy={false} onSave={onSave} />)
    await user.selectOptions(screen.getByTestId('default-pc-select'), laptopId)
    rerender(
      <DefaultPCForm
        list={listOf([
          node({ id: deskId, display_name: 'Desk', online: true }),
          node({ id: laptopId, display_name: 'Laptop', revocation_status: 'pending' }),
        ], laptopId, true)}
        saved={null}
        canWrite
        busy={false}
        onSave={onSave}
      />,
    )
    expect(screen.getByTestId('default-pc-select')).toHaveValue('')
    expect(screen.getByTestId('default-pc-select')).not.toHaveValue(deskId)
    expect(screen.getByTestId('default-pc-current')).toHaveTextContent(laptopId)
    expect(screen.getByTestId('default-pc-invalid')).toHaveTextContent('需要重新选择')
    expect(screen.getByTestId('default-pc-save')).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('注册凭据', () => {
  it('只显示一次，并且不写入 localStorage', async () => {
    const user = userEvent.setup()
    const token = 'enroll-secret-once-only'
    const issued: Enrollment = {
      enrollment_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      enrollment_token: token,
      expires_at: '2026-10-17T00:10:00Z',
    }
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    function Harness() {
      const [value, setValue] = useState<Enrollment | null>(issued)
      return (
        <EnrollmentPanel
          enrollment={value}
          origin="https://baton.example"
          busy={false}
          canWrite
          onIssue={vi.fn()}
          onDismiss={() => setValue(null)}
        />
      )
    }
    render(<Harness />)
    expect(screen.getByTestId('enrollment-token')).toHaveValue(token)
    expect(screen.getByTestId('register-usage')).toHaveTextContent('batond register')
    expect(screen.getByTestId('register-usage')).not.toHaveTextContent(token)
    expect(setItem.mock.calls.some((call) => String(call[1]).includes(token))).toBe(false)
    expect(localStorage.length).toBe(0)
    await user.click(screen.getByTestId('enrollment-dismiss'))
    expect(screen.queryByTestId('enrollment-token')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(token)
  })
})
