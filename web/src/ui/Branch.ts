import * as stylex from '@stylexjs/stylex'
import { colors, space } from '../theme/tokens.stylex'

// 分支线：对话里的 Thread 组、事项选项和附件不加外壳，一行 muted 标题下面的行挂在左侧的 borderSoft 竖线上。
export const branch = stylex.create({
  title: { display: 'flex', alignItems: 'center', gap: space.sm, color: colors.muted },
  line: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    marginLeft: '7px',
    paddingLeft: space.sm,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSoft,
  },
})
