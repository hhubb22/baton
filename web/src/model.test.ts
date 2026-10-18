import { describe, expect, it } from 'vitest'
import {
  applyRevoke,
  applySavedDefault,
  commandOrigin,
  currentDefaultText,
  eligibleDefaultNodes,
  formatReportTime,
  registerUsage,
  revocationLabel,
  savedDefaultSummary,
} from './model.ts'
import { deskId, laptopId, listOf, node, saved } from './test/fixtures.ts'

describe('节点展示', () => {
  it('没有报告时间时不把它说成当前在线', () => {
    expect(formatReportTime(null)).toBe('尚未报告')
    expect(formatReportTime('not-a-time')).toBe('时间无效')
    expect(formatReportTime('2026-10-17T12:00:00Z')).toContain('2026')
  })

  it('失效的默认设备仍指向原节点', () => {
    const desk = node({ id: deskId, display_name: 'Desk', registration_seq: 1, revocation_status: 'effective' })
    const laptop = node({ id: laptopId, display_name: 'Laptop', registration_seq: 2 })
    const list = listOf([desk, laptop], deskId, true)
    expect(currentDefaultText(list)).toContain('Desk')
    expect(currentDefaultText(list)).toContain(deskId)
    expect(currentDefaultText(list)).not.toContain('Laptop')
    expect(eligibleDefaultNodes(list.nodes).map((item) => item.id)).toEqual([laptopId])
  })

  it('所有未吊销节点都可以选为默认设备', () => {
    const nodes = [
      node({ id: deskId, display_name: 'Desk', revocation_status: 'pending' }),
      node({ id: laptopId, display_name: 'Laptop', online: false }),
      node({ id: '33333333-3333-4333-8333-333333333333', display_name: 'Ubuntu' }),
    ]
    expect(eligibleDefaultNodes(nodes).map((item) => item.display_name)).toEqual(['Laptop', 'Ubuntu'])
  })

  it('保存结果使用响应里的节点，而不是请求里选中的节点', () => {
    const list = listOf([
      node({ id: deskId, display_name: 'Desk' }),
      node({ id: laptopId, display_name: 'Laptop' }),
    ], laptopId)
    const actual = saved(deskId, 'Desk', 4)
    expect(applySavedDefault(list, actual).default_device.node_id).toBe(deskId)
    expect(savedDefaultSummary(actual)).toContain('Desk')
    expect(savedDefaultSummary(actual)).not.toContain('Laptop')
  })

  it('吊销响应区分为处理中和已生效', () => {
    const list = listOf([node({ id: deskId, display_name: 'Desk', executable: true })], deskId)
    const pending = applyRevoke(list, {
      node_id: deskId,
      status: 'pending',
      operator_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      credential_ids: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      requested_at: '2026-10-17T00:00:00Z',
      applied_at: null,
      message: '吊销正在处理，尚未生效。',
      local_process_notice: '不会停止离线进程',
      default_device: { node_id: deskId, invalid: true, needs_reselection: true, message: '需要重新选择' },
    })
    expect(pending.nodes[0]?.revocation_status).toBe('pending')
    expect(pending.nodes[0]?.executable).toBe(false)
    expect(pending.default_device.node_id).toBe(deskId)
    expect(pending.default_device.needs_reselection).toBe(true)
    expect(revocationLabel('pending')).toBe('处理中')
    expect(revocationLabel('effective')).toBe('已生效')
    expect(revocationLabel('pending')).not.toContain('已生效')
  })

  it('注册命令不包含凭据', () => {
    const token = 'enroll-secret-should-not-appear'
    const usage = registerUsage('https://baton.example:8443')
    expect(usage).toContain('batond register --coordinator https://baton.example:8443')
    expect(usage).toContain('BATON_ENROLLMENT_TOKEN')
    expect(usage).not.toContain(token)
    expect(commandOrigin('http://baton.example')).toBe('https://主机')
    expect(commandOrigin(`https://baton.example/?${token}`)).toBe('https://主机')
  })
})
