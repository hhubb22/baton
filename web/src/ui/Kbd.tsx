import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { radius } from '../theme/tokens.stylex'

const styles = stylex.create({
  kbd: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '18px',
    paddingInline: '5px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.inner,
    backgroundColor: semantic.card,
    color: semantic.faintForeground,
    fontFamily: 'inherit',
    fontSize: '11px',
    lineHeight: 1,
  },
})

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd {...stylex.props(styles.kbd)}>{children}</kbd>
}
