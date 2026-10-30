import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import type { ThreadQuestion } from '../data/types'
import { ThreadQuestionForm } from './ThreadQuestionForm'
import { ThreadQuestionAnswerStatus } from './ThreadQuestionAnswerStatus'

it('shows approval choices and submits the selected provider decision', async () => {
  const user = userEvent.setup()
  const answer = vi.fn().mockResolvedValue(undefined)
  render(
    <ThreadQuestionForm
      question={{
        request_id: 'approval-1',
        kind: 'approval',
        questions: [],
        reason: '运行命令需要批准',
        options: [{ decision: 'acceptForSession', label: '本次会话允许', warning: '适用于后续操作' }],
      }}
      onAnswer={answer}
    />,
  )
  expect(screen.getByText('运行命令需要批准')).toBeInTheDocument()
  expect(screen.getByText('适用于后续操作')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '本次会话允许' }))
  expect(answer).toHaveBeenCalledWith({ request_id: 'approval-1', decision: 'acceptForSession' })
})

const question: ThreadQuestion = {
  request_id: 'targets',
  kind: 'user_input',
  questions: [
    {
      id: 'platform',
      header: 'Platforms',
      question: 'Which platforms?',
      multiSelect: true,
      options: [
        { label: 'Linux build', description: 'Build for Linux', value: 'linux' },
        { label: 'Mac build', description: '', value: 'macos' },
      ],
    },
    {
      id: 'release',
      header: 'Release',
      question: 'Which release?',
      options: [{ label: 'Stable', description: '', value: 'stable' }],
      initialAnswer: 'stable',
    },
  ],
}

it('submits upstream string values, multiple selections, and custom text without sending a new message', async () => {
  const answer = vi.fn(async () => {})
  const user = userEvent.setup()
  render(<ThreadQuestionForm question={question} onAnswer={answer} />)
  await user.click(screen.getByRole('checkbox', { name: /Linux build/ }))
  await user.click(screen.getByRole('checkbox', { name: 'Mac build' }))
  await user.type(screen.getAllByRole('textbox')[0], 'Windows')
  await user.click(screen.getByRole('button', { name: '发送回答' }))
  expect(answer).toHaveBeenCalledExactlyOnceWith({
    request_id: 'targets',
    decision: 'accept',
    answers: { platform: ['linux', 'macos', 'Windows'], release: 'stable' },
  })
})

it('keeps choices after a save failure and lets users cancel without required answers', async () => {
  const answer = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
  const user = userEvent.setup()
  render(<ThreadQuestionForm question={question} onAnswer={answer} />)
  await user.click(screen.getByRole('checkbox', { name: /Linux build/ }))
  await user.click(screen.getByRole('button', { name: '发送回答' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('checkbox', { name: /Linux build/ })).toBeChecked()
  await user.click(screen.getByRole('button', { name: '关闭问题' }))
  expect(answer).toHaveBeenLastCalledWith({ request_id: 'targets', decision: 'cancel' })
})

it('shows an MCP prompt and accepts confirmation with no questions', async () => {
  const answer = vi.fn(async () => {})
  const user = userEvent.setup()
  render(
    <ThreadQuestionForm
      question={{ request_id: 'mcp', kind: 'mcp-elicitation', questions: [], prompt: 'Connect to the MCP server?' }}
      onAnswer={answer}
    />,
  )
  expect(screen.getByText('Connect to the MCP server?')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '继续' }))
  expect(answer).toHaveBeenCalledExactlyOnceWith({ request_id: 'mcp', decision: 'accept', answers: {} })
})

it('treats prototype-named question IDs as ordinary required fields', async () => {
  const answer = vi.fn(async () => {})
  const user = userEvent.setup()
  render(
    <ThreadQuestionForm
      question={{
        request_id: 'name',
        kind: 'user_input',
        questions: [{ id: 'toString', header: 'Name', question: 'Which name?', options: [] }],
      }}
      onAnswer={answer}
    />,
  )
  await user.click(screen.getByRole('button', { name: '发送回答' }))
  expect(answer).not.toHaveBeenCalled()
  await user.type(screen.getByRole('textbox'), 'Build')
  await user.click(screen.getByRole('button', { name: '发送回答' }))
  expect(answer).toHaveBeenCalledExactlyOnceWith({
    request_id: 'name',
    decision: 'accept',
    answers: { toString: 'Build' },
  })
})

it('explains uncertain answer delivery and preserves the original message', () => {
  render(
    <ThreadQuestionAnswerStatus
      answer={{ request_id: 'targets', decision: 'accept', outcome: 'unknown', reason: 'answer_delivery_uncertain' }}
      offline={false}
    />,
  )
  expect(screen.getByRole('status')).toHaveTextContent('无法确认助手是否收到回答')
  expect(screen.getByRole('status')).toHaveTextContent('不会自动重发回答或原消息')
})
