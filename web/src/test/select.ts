import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

// 打开 ui/Select 并选中一项。弹层渲染在 portal 里，从整个文档查找选项。
export async function chooseOption(user: UserEvent, trigger: HTMLElement, name: string | RegExp) {
  await user.click(trigger)
  await user.click(await screen.findByRole('option', { name }))
}
