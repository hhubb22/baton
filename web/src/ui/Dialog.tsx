import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import * as stylex from '@stylexjs/stylex'
import type { ComponentProps, ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { motion, radius, shadow, space } from '../theme/tokens.stylex'

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 30,
    backgroundColor: semantic.overlay,
    opacity: 1,
    transitionProperty: 'opacity',
    transitionDuration: motion.modal,
    transitionTimingFunction: motion.easeOut,
  },
  popup: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    zIndex: 31,
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    width: '480px',
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'calc(100vh - 64px)',
    overflowY: 'auto',
    padding: space.xl,
    opacity: 1,
    transform: 'translate(-50%, -50%)',
    transitionProperty: 'opacity, transform',
    transitionDuration: motion.modal,
    transitionTimingFunction: motion.easeOut,
    backgroundColor: semantic.popover,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.xl,
    boxShadow: shadow.modal,
    color: semantic.foreground,
    outline: 'none',
  },
  popupHidden: { opacity: 0, transform: 'translate(-50%, -50%) scale(0.98)' },
  hidden: { opacity: 0 },
  leaving: { transitionDuration: motion.exit },
  wide: { width: '600px' },
  header: { display: 'flex', flexDirection: 'column', gap: space.sm },
  description: { color: semantic.mutedForeground },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  note: { color: semantic.faintForeground },
  actions: { display: 'flex', gap: space.sm, marginLeft: 'auto' },
})

// 弹窗是第二层浮层；需要第三层时替换当前弹窗，不叠加。
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  note,
  actions,
  wide,
  finalFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  note?: ReactNode
  actions?: ReactNode
  wide?: boolean
  // 关闭后焦点回到哪里；默认回到打开弹窗的按钮，按钮已经不在页面上时由调用方指定。
  finalFocus?: ComponentProps<typeof BaseDialog.Popup>['finalFocus']
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={(state) =>
            stylex.props(
              styles.backdrop,
              state.transitionStatus !== undefined && styles.hidden,
              state.transitionStatus === 'ending' && styles.leaving,
            ).className ?? ''
          }
        />
        <BaseDialog.Popup
          finalFocus={finalFocus}
          className={(state) =>
            stylex.props(
              styles.popup,
              wide && styles.wide,
              state.transitionStatus !== undefined && styles.popupHidden,
              state.transitionStatus === 'ending' && styles.leaving,
            ).className ?? ''
          }
        >
          <div {...stylex.props(styles.header)}>
            <BaseDialog.Title {...stylex.props(text.heading)}>{title}</BaseDialog.Title>
            {description && (
              <BaseDialog.Description {...stylex.props(text.small, styles.description)}>
                {description}
              </BaseDialog.Description>
            )}
          </div>
          {children}
          {(note || actions) && (
            <div {...stylex.props(styles.footer)}>
              {note && <span {...stylex.props(text.caption, styles.note)}>{note}</span>}
              <div {...stylex.props(styles.actions)}>{actions}</div>
            </div>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

export const DialogClose = BaseDialog.Close
