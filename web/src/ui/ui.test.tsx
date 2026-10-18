import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api.ts'
import type { Enrollment, NodeStatus } from '../types.ts'
import { deskId, laptopId, listOf, node, saved } from '../test/fixtures.ts'
import { DefaultDeviceForm } from './DefaultDeviceForm.tsx'
import { EnrollmentPanel } from './EnrollmentPanel.tsx'
import { FileBrowser } from './FileBrowser.tsx'
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
        loadFiles={vi.fn()}
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
      <NodeCard node={deskNode()} notice={notice} canWrite busy={false} onRevoke={onRevoke} loadFiles={vi.fn()} />,
    )
    await user.click(screen.getByTestId('revoke-open'))
    expect(screen.queryByText('已生效')).not.toBeInTheDocument()
    rerender(<NodeCard node={deskNode()} notice={notice} canWrite busy onRevoke={onRevoke} loadFiles={vi.fn()} />)
    expect(screen.getByTestId('revoke-confirm')).toHaveTextContent('正在提交')
    rerender(<NodeCard node={deskNode()} notice={notice} canWrite busy={false} onRevoke={onRevoke} loadFiles={vi.fn()} />)
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
        loadFiles={vi.fn()}
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
        loadFiles={vi.fn()}
      />,
    )
    const done = screen.getByTestId('revoke-status')
    expect(done).toHaveAttribute('data-status', 'effective')
    expect(done).toHaveTextContent('已生效')
    expect(done).toHaveTextContent('不会停止')
    expect(done).not.toHaveTextContent('处理中')
  })
})

describe('文件浏览', () => {
  it('列出授权目录、预览文本，并标出截断', async () => {
    const user = userEvent.setup()
    const load = vi.fn(async (_nodeId: string, query: { root_id?: string; path?: string }) => {
      if (!query.root_id) {
        return { operation_id: 'op-1', node_id: deskId, kind: 'roots', roots: [{ id: 'notes' }], truncated: false }
      }
      if (query.path === 'hello.txt') {
        return { operation_id: 'op-2', node_id: deskId, kind: 'file', root_id: 'notes', path: 'hello.txt', content: 'hello from node', truncated: false }
      }
      if (query.path === 'big.txt') {
        return {
          operation_id: 'op-3',
          node_id: deskId,
          kind: 'file',
          root_id: 'notes',
          path: 'big.txt',
          content: 'AAAA',
          truncated: true,
          remainder: { root_id: 'notes', path: 'big.txt', kind: 'file', offset: 4, size: 99999 },
        }
      }
      return {
        operation_id: 'op-4',
        node_id: deskId,
        kind: 'directory',
        root_id: 'notes',
        path: '',
        entries: [
          { name: 'hello.txt', kind: 'file', size: 15 },
          { name: 'big.txt', kind: 'file', size: 99999 },
        ],
        truncated: false,
      }
    })
    render(<FileBrowser nodeId={deskId} online revoked={false} load={load} />)
    await user.click(screen.getByTestId('browse-open'))
    expect(await screen.findByTestId('browse-root-notes')).toBeInTheDocument()
    await user.click(screen.getByTestId('browse-root-notes'))
    await user.click(await screen.findByTestId('browse-entry-hello.txt'))
    expect(await screen.findByTestId('browse-preview')).toHaveTextContent('hello from node')
    expect(screen.queryByTestId('browse-truncated')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('browse-entry-big.txt'))
    expect(await screen.findByTestId('browse-truncated')).toHaveTextContent('不会继续传输')
    expect(screen.getByTestId('browse-preview')).toHaveTextContent('AAAA')
  })

  it('离线节点不能发起浏览', () => {
    const load = vi.fn()
    render(<FileBrowser nodeId={deskId} online={false} revoked={false} load={load} />)
    expect(screen.getByTestId('browse-open')).toBeDisabled()
    expect(screen.getByTestId('browse-offline')).toHaveTextContent('节点离线')
    expect(load).not.toHaveBeenCalled()
  })

  it('符号链接逃逸显示拒绝原因，不显示目录外内容', async () => {
    const user = userEvent.setup()
    const load = vi.fn(async (_nodeId: string, query: { root_id?: string; path?: string }) => {
      if (!query.root_id) {
        return { operation_id: 'op-5', node_id: deskId, kind: 'roots', roots: [{ id: 'notes' }], truncated: false }
      }
      if (query.path === 'escape.txt') {
        throw new ApiError(403, 'path_escaped', '路径超出允许的目录', 'req-1')
      }
      return {
        operation_id: 'op-6',
        node_id: deskId,
        kind: 'directory',
        root_id: 'notes',
        entries: [{ name: 'escape.txt', kind: 'symlink' }],
        truncated: false,
      }
    })
    render(<FileBrowser nodeId={deskId} online revoked={false} load={load} />)
    await user.click(screen.getByTestId('browse-open'))
    await user.click(await screen.findByTestId('browse-root-notes'))
    await user.click(await screen.findByTestId('browse-entry-escape.txt'))
    expect(await screen.findByTestId('browse-error')).toHaveTextContent('路径超出允许的目录')
    expect(screen.queryByTestId('browse-preview')).not.toBeInTheDocument()
    expect(screen.queryByText('OUTSIDE_SENTINEL')).not.toBeInTheDocument()
  })
})

describe('默认设备', () => {
  it('默认节点失效时不自动改选', () => {
    const list = listOf([
      node({ id: deskId, display_name: 'Desk', revocation_status: 'effective' }),
      node({ id: laptopId, display_name: 'Laptop' }),
    ], deskId, true)
    render(<DefaultDeviceForm list={list} saved={null} canWrite busy={false} onSave={vi.fn()} />)
    expect(screen.getByTestId('default-device-select')).toHaveValue('')
    expect(screen.getByTestId('default-device-current')).toHaveTextContent(deskId)
    expect(screen.getByTestId('default-device-current')).not.toHaveTextContent('Laptop')
    expect(screen.getByTestId('default-device-invalid')).toHaveTextContent('需要重新选择')
  })

  it('展示响应里保存的节点，并允许选择离线节点', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const list = listOf([
      node({ id: deskId, display_name: 'Desk', online: true }),
      node({ id: laptopId, display_name: 'Laptop', online: false }),
    ], deskId)
    const { rerender } = render(<DefaultDeviceForm list={list} saved={null} canWrite busy={false} onSave={onSave} />)
    await user.selectOptions(screen.getByTestId('default-device-select'), laptopId)
    expect(screen.getByTestId('default-device-offline')).toBeInTheDocument()
    expect(screen.getByTestId('default-device-current')).toHaveTextContent(deskId)
    await user.click(screen.getByTestId('default-device-save'))
    expect(onSave).toHaveBeenCalledWith(laptopId)
    const actual = saved(deskId, 'Desk From Server', 9)
    rerender(<DefaultDeviceForm list={list} saved={actual} canWrite busy={false} onSave={onSave} />)
    expect(screen.getByTestId('default-device-saved')).toHaveTextContent('Desk From Server')
    expect(screen.getByTestId('default-device-saved')).toHaveTextContent(deskId)
    expect(screen.getByTestId('default-device-saved')).not.toHaveTextContent('Laptop')
  })

  it('已选节点失效后清空选择，不改派到其他节点', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const list = listOf([
      node({ id: deskId, display_name: 'Desk', online: true }),
      node({ id: laptopId, display_name: 'Laptop', online: false }),
    ], laptopId)
    const { rerender } = render(<DefaultDeviceForm list={list} saved={null} canWrite busy={false} onSave={onSave} />)
    await user.selectOptions(screen.getByTestId('default-device-select'), laptopId)
    rerender(
      <DefaultDeviceForm
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
    expect(screen.getByTestId('default-device-select')).toHaveValue('')
    expect(screen.getByTestId('default-device-select')).not.toHaveValue(deskId)
    expect(screen.getByTestId('default-device-current')).toHaveTextContent(laptopId)
    expect(screen.getByTestId('default-device-invalid')).toHaveTextContent('需要重新选择')
    expect(screen.getByTestId('default-device-save')).toBeDisabled()
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
