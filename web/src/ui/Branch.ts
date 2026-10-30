import * as stylex from '@stylexjs/stylex'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'

// 分支线：对话里的 Thread 组和附件不加外壳，一行 muted 标题下面的行挂在左侧的 border 竖线上。
export const branch = stylex.create({
  title: { display: 'flex', alignItems: 'center', gap: space.sm, color: semantic.mutedForeground },
  line: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    marginLeft: '7px',
    paddingLeft: space.sm,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: semantic.border,
  },
})
