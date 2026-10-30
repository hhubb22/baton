import { Autocomplete } from '@base-ui/react/autocomplete'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, shadow, space } from '../theme/tokens.stylex'
import { Icon } from './Icon'

// 转写自 coss ui 的 Command（MIT）。命令面板是高频操作，直接出现，不加动画。
const styles = stylex.create({
  backdrop: { position: 'fixed', inset: 0, zIndex: 30, backgroundColor: semantic.overlay },
  popup: {
    position: 'fixed',
    top: '12vh',
    left: '50%',
    zIndex: 31,
    display: 'flex',
    flexDirection: 'column',
    width: '576px',
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: '420px',
    transform: 'translateX(-50%)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.xl,
    backgroundColor: semantic.popover,
    boxShadow: shadow.modal,
    color: semantic.foreground,
    outline: 'none',
    overflow: 'hidden',
  },
  search: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    height: '44px',
    paddingInline: space.lg,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: semantic.border,
    color: semantic.mutedForeground,
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: semantic.foreground,
    '::placeholder': { color: semantic.faintForeground },
  },
  list: { minHeight: 0, overflowY: 'auto', padding: space.sm, scrollPaddingBlock: space.sm },
  empty: { paddingBlock: space.xl, color: semantic.mutedForeground, textAlign: 'center' },
  groupLabel: {
    display: 'flex',
    alignItems: 'center',
    height: '28px',
    paddingInline: space.sm,
    color: semantic.faintForeground,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minHeight: '32px',
    paddingInline: space.sm,
    borderRadius: radius.sm,
    cursor: 'default',
    outline: 'none',
    userSelect: 'none',
  },
  highlighted: { backgroundColor: semantic.accent },
  label: { flexGrow: 1 },
  shortcut: { color: semantic.faintForeground, fontFamily: 'inherit', fontSize: '12px' },
})

export type CommandItem = {
  id: string
  label: string
  leading?: ReactNode
  shortcut?: ReactNode
  onSelect: () => void
}

export type CommandGroup = { label: string; items: CommandItem[] }

export function CommandDialog({
  open,
  onOpenChange,
  groups,
  label,
  placeholder,
  empty,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: CommandGroup[]
  label: string
  placeholder: string
  empty: ReactNode
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop {...stylex.props(styles.backdrop)} />
        <BaseDialog.Popup aria-label={label} {...stylex.props(styles.popup)}>
          <Autocomplete.Root
            open
            inline
            autoHighlight="always"
            keepHighlight
            items={groups}
            itemToStringValue={(item: CommandItem) => item.label}
          >
            <div {...stylex.props(styles.search)}>
              <Icon name="file-search" size={16} />
              <Autocomplete.Input
                autoFocus
                aria-label={label}
                placeholder={placeholder}
                {...stylex.props(text.small, styles.input)}
              />
            </div>
            <Autocomplete.Empty>
              <div {...stylex.props(text.small, styles.empty)}>{empty}</div>
            </Autocomplete.Empty>
            <Autocomplete.List {...stylex.props(styles.list)}>
              {(group: CommandGroup) => (
                <Autocomplete.Group key={group.label} items={group.items}>
                  <Autocomplete.GroupLabel {...stylex.props(text.captionMedium, styles.groupLabel)}>
                    {group.label}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(item: CommandItem) => (
                      <Autocomplete.Item
                        key={item.id}
                        value={item}
                        onClick={() => {
                          item.onSelect()
                          onOpenChange(false)
                        }}
                        className={(state) =>
                          stylex.props(text.small, styles.item, state.highlighted && styles.highlighted).className ?? ''
                        }
                      >
                        {item.leading}
                        <span {...stylex.props(styles.label, text.truncate)}>{item.label}</span>
                        {item.shortcut && <kbd {...stylex.props(styles.shortcut)}>{item.shortcut}</kbd>}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
          </Autocomplete.Root>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
