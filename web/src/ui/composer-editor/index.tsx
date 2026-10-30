// 转写自 coss ui 的 Composer（MIT，见同目录 coss-LICENSE.txt）：结构化草稿、提及和斜杠命令。
// composer-*.ts 和 use-composer-editor.ts 保持上游内容，只改了相对路径。
import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { mergeProps } from '@base-ui/react/merge-props'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { useRender } from '@base-ui/react/use-render'
import * as stylex from '@stylexjs/stylex'
import type { ComponentProps, MouseEvent, PointerEvent, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { weight } from '../../theme/base.stylex'
import { semantic } from '../../theme/semantic.stylex'
import { motion, radius, shadow, space } from '../../theme/tokens.stylex'
import { focusRing } from '../Button'
import {
  type ComposerEditorOptions,
  ComposerEditorProvider,
  type ComposerItemValue,
  type ComposerTokenPart,
  focusComposerInput,
  getComposerText,
  useComposerAnchorContext,
  useComposerEditorContext,
  useComposerInputLayout,
  useComposerItem,
  useComposerSuggestionsContext,
} from './composer-editor'
import './composer.css'

const styles = stylex.create({
  frame: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    paddingBottom: '7px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: semantic.input, ':focus-within': semantic.ring },
    borderRadius: radius.xl,
    backgroundColor: semantic.card,
    boxShadow: { default: shadow.control, ':focus-within': shadow.focus },
    color: semantic.foreground,
    cursor: 'text',
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: motion.micro,
  },
  scroll: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    maxHeight: 'min(var(--composer-max-height, 240px), 50dvh)',
    paddingTop: '7px',
    overflowY: 'auto',
    fontSize: '14px',
  },
  input: {
    position: 'relative',
    display: 'block',
    width: '100%',
    minWidth: 0,
    minHeight: 'calc(1lh + 8px)',
    paddingBlock: space.xs,
    paddingInline: '11px',
    borderWidth: 0,
    outline: 'none',
    resize: 'none',
    backgroundColor: 'transparent',
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
    '::placeholder': { color: semantic.faintForeground },
  },
  token: { fontWeight: weight.medium, color: semantic.brandForeground, cursor: 'default' },
  tokenChip: {
    paddingBlock: '1px',
    paddingInline: '6px',
    borderRadius: radius.sm,
    backgroundColor: semantic.accent,
    color: semantic.foreground,
    fontWeight: weight.regular,
    boxDecorationBreak: 'clone',
  },
  positioner: { zIndex: 40, width: 'var(--anchor-width)' },
  popup: {
    width: 'var(--anchor-width)',
    maxWidth: 'var(--available-width)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    backgroundColor: semantic.popover,
    boxShadow: shadow.floating,
    color: semantic.foreground,
    outline: 'none',
  },
  list: { maxHeight: 'min(var(--available-height), 16rem)', overflowY: 'auto', padding: space.xs },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: '32px',
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
    color: semantic.foreground,
    cursor: 'default',
    fontSize: '13px',
    outline: 'none',
    textAlign: 'start',
    userSelect: 'none',
  },
  highlighted: { backgroundColor: semantic.accent },
  disabled: { opacity: 0.64, pointerEvents: 'none' },
  status: {
    display: { default: 'block', ':empty': 'none' },
    paddingBlock: space.sm,
    paddingInline: space.md,
    color: semantic.mutedForeground,
    fontSize: '12px',
    fontWeight: weight.medium,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    gap: space.sm,
    marginInline: '7px',
  },
  group: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space.xs, minWidth: 0 },
  groupEnd: { justifyContent: 'flex-end', marginInlineStart: 'auto' },
  submit: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '32px',
    height: '32px',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: { default: semantic.primary, ':hover': semantic.primaryHover, ':disabled': semantic.secondary },
    boxShadow: { default: shadow.filled, ':disabled': 'none' },
    color: { default: semantic.primaryForeground, ':disabled': semantic.faintForeground },
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: 'background-color, transform',
    transitionDuration: motion.micro,
  },
})

type ComposerFormProps = useRender.ComponentProps<'form'>
type ComposerLayout = 'stacked' | 'adaptive'

function ComposerFrame({
  layout = 'stacked',
  render,
  ref,
  name,
  children,
  style,
  ...props
}: Omit<ComposerFormProps, 'style' | 'className'> & {
  layout?: ComposerLayout
  style?: stylex.StyleXStyles
}): ReactElement {
  const editor = useComposerEditorContext()
  const anchorRef = useComposerAnchorContext()
  const defaultProps = {
    'data-slot': 'composer',
    'data-layout': layout,
    'data-base-ui-swipe-ignore': '',
    onMouseDown: (event: MouseEvent<HTMLFormElement>): void => {
      focusComposerInput(event, true)
    },
    onClick: (event: MouseEvent<HTMLFormElement>): void => {
      focusComposerInput(event, false)
    },
    'data-disabled': editor?.disabled ? '' : undefined,
    'data-readonly': editor?.readOnly ? '' : undefined,
    children: (
      <>
        {children}
        {name && (
          <input type="hidden" name={name} value={getComposerText(editor?.value ?? [])} disabled={editor?.disabled} />
        )}
      </>
    ),
    ...stylex.props(styles.frame, style),
  }
  return useRender({
    defaultTagName: 'form',
    render,
    ref: [anchorRef ?? null, ref ?? null],
    props: mergeProps<'form'>(defaultProps, editor?.formProps ?? {}, props),
  })
}

export type ComposerProps = Omit<ComposerFormProps, 'defaultValue' | 'onSubmit' | 'name' | 'style' | 'className'> &
  ComposerEditorOptions & { layout?: ComposerLayout; style?: stylex.StyleXStyles }

export function Composer({
  layout,
  value,
  defaultValue,
  onValueChange,
  onSubmit,
  onQueryChange,
  onAction,
  submitOnEmptySuggestions,
  triggers,
  disabled,
  readOnly,
  submitDisabled,
  allowEmpty,
  submitOnEnter,
  name,
  getSuggestionsAnnouncement,
  ...frameProps
}: ComposerProps): ReactElement {
  return (
    <ComposerEditorProvider
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      onSubmit={onSubmit}
      onQueryChange={onQueryChange}
      onAction={onAction}
      submitOnEmptySuggestions={submitOnEmptySuggestions}
      triggers={triggers}
      disabled={disabled}
      readOnly={readOnly}
      submitDisabled={submitDisabled}
      allowEmpty={allowEmpty}
      submitOnEnter={submitOnEnter}
      getSuggestionsAnnouncement={getSuggestionsAnnouncement}
    >
      <ComposerFrame {...frameProps} layout={layout} name={name} />
    </ComposerEditorProvider>
  )
}

export function ComposerInput({
  placeholder,
  renderToken,
  render,
  ref,
  style,
  ...props
}: Omit<useRender.ComponentProps<'div'>, 'style' | 'className'> & {
  placeholder?: string
  renderToken?: (token: ComposerTokenPart) => ReactNode
  style?: stylex.StyleXStyles
}): ReactElement {
  const editor = useComposerEditorContext()
  const suggestions = useComposerSuggestionsContext()
  const tokenHosts = editor?.tokenHosts
  const { scrollRef, inputRef: layoutInputRef } = useComposerInputLayout()
  const textarea = editor?.isTextarea ?? false
  const { ref: editorRef, ...editorProps } = editor?.inputProps ?? {}
  const defaultProps = {
    'data-slot': 'composer-input',
    ...(render === undefined
      ? {
          contentEditable: true,
          role: 'textbox' as const,
          'aria-multiline': true as const,
          suppressContentEditableWarning: true,
        }
      : {}),
    'data-empty': !textarea && editor?.isEmpty && !editor.isComposing ? '' : undefined,
    ...(textarea ? { placeholder } : {}),
    'data-placeholder': placeholder,
    'aria-placeholder': editor ? placeholder : undefined,
    ...stylex.props(styles.input, style),
  }
  const inputBehaviorProps = textarea
    ? { contentEditable: undefined, disabled: editor?.disabled, readOnly: editor?.readOnly }
    : (suggestions?.inputProps ?? {})
  const input = useRender({
    defaultTagName: 'div',
    render,
    ref: [editorRef ?? null, layoutInputRef, ref ?? null],
    props: mergeProps<'div'>(defaultProps, editorProps, inputBehaviorProps, props),
  })
  return (
    <>
      <div ref={scrollRef} data-slot="composer-scroll-area" {...stylex.props(styles.scroll)}>
        {input}
      </div>
      {tokenHosts?.map((host, index) => {
        const node = host.parentElement
        if (!node) return null
        const token: ComposerTokenPart = {
          type: node.dataset.composerToken === 'action' ? 'action' : 'mention',
          id: node.dataset.id ?? '',
          label: node.dataset.label ?? '',
          trigger: node.dataset.trigger ?? '@',
          ...(node.dataset.kind ? { kind: node.dataset.kind } : {}),
          ...(node.dataset.data !== undefined ? { data: node.dataset.data } : {}),
          ...(node.dataset.text !== undefined ? { text: node.dataset.text } : {}),
        }
        return createPortal(renderToken?.(token) ?? <ComposerToken token={token} />, host, String(index))
      })}
    </>
  )
}

export function ComposerToken({
  variant = 'default',
  token,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'contentEditable' | 'className' | 'style'> & {
  variant?: 'default' | 'chip'
  token: ComposerTokenPart
}): ReactElement {
  return (
    <span
      contentEditable={false}
      data-kind={token.kind}
      data-slot="composer-token"
      data-type={token.type}
      data-variant={variant}
      {...props}
      {...stylex.props(styles.token, variant === 'chip' && styles.tokenChip)}
    >
      <span data-slot="composer-token-label">
        {variant === 'default' && token.trigger}
        {children ?? token.label}
      </span>
    </span>
  )
}

export function ComposerPopup({
  side = 'top',
  align = 'start',
  sideOffset = 4,
  ...props
}: Omit<ComponentProps<typeof PopoverPrimitive.Popup>, 'className' | 'style'> & {
  side?: ComponentProps<typeof PopoverPrimitive.Positioner>['side']
  align?: ComponentProps<typeof PopoverPrimitive.Positioner>['align']
  sideOffset?: ComponentProps<typeof PopoverPrimitive.Positioner>['sideOffset']
}): ReactElement {
  const anchorRef = useComposerAnchorContext()
  const editor = useComposerEditorContext()
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        anchor={anchorRef ?? undefined}
        side={side}
        align={align}
        sideOffset={sideOffset}
        data-slot="composer-positioner"
        {...stylex.props(styles.positioner)}
      >
        <PopoverPrimitive.Popup
          data-slot="composer-popup"
          role={editor ? 'presentation' : undefined}
          initialFocus={editor ? false : undefined}
          finalFocus={editor ? false : undefined}
          {...props}
          {...stylex.props(styles.popup)}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export function ComposerList({
  children,
  render,
  ref,
  ...props
}: Omit<useRender.ComponentProps<'div'>, 'children'> & {
  children?: ReactNode | ((item: ComposerItemValue, index: number) => ReactNode)
}): ReactElement {
  const suggestions = useComposerSuggestionsContext()
  const defaultProps = {
    'data-slot': 'composer-list',
    id: suggestions?.listId,
    role: suggestions ? 'listbox' : undefined,
    'aria-label': suggestions ? '建议' : undefined,
    children:
      typeof children === 'function'
        ? (suggestions?.items as readonly ComposerItemValue[] | undefined)?.map(children)
        : children,
    ...stylex.props(styles.list),
  }
  return useRender({
    defaultTagName: 'div',
    render,
    ref: [suggestions?.registerList ?? null, ref ?? null],
    props: mergeProps<'div'>(defaultProps, props),
  })
}

export function ComposerItem({
  value,
  disabled: disabledProp,
  render,
  ref,
  ...props
}: Omit<useRender.ComponentProps<'button', { highlighted: boolean; disabled: boolean }>, 'value'> & {
  value?: ComposerItemValue
}): ReactElement {
  const disabled = Boolean(disabledProp || value?.disabled)
  const item = useComposerItem(value, disabled)
  const { highlighted } = item
  const defaultProps = {
    ...item.props,
    type: 'button' as const,
    'data-slot': 'composer-item',
    disabled,
    ...stylex.props(styles.item, highlighted && styles.highlighted, disabled && styles.disabled),
  }
  return useRender({
    defaultTagName: 'button',
    render,
    ref: [item.ref, ref ?? null],
    state: { highlighted, disabled },
    props: mergeProps<'button'>(defaultProps, props),
  })
}

export function ComposerStatus({ render, ref, ...props }: useRender.ComponentProps<'div'>): ReactElement {
  const defaultProps = { role: 'status', 'data-slot': 'composer-status', ...stylex.props(styles.status) }
  return useRender({
    defaultTagName: 'div',
    render,
    ref,
    props: mergeProps<'div'>(defaultProps, props),
  })
}

export function ComposerActions(props: Omit<ComponentProps<'div'>, 'className' | 'style'>): ReactElement {
  return <div data-slot="composer-actions" {...props} {...stylex.props(styles.actions)} />
}

export function ComposerActionGroup({
  align = 'start',
  ...props
}: Omit<ComponentProps<'div'>, 'className' | 'style'> & { align?: 'start' | 'end' }): ReactElement {
  return (
    <div
      data-align={align}
      data-slot="composer-action-group"
      {...props}
      {...stylex.props(styles.group, align === 'end' && styles.groupEnd)}
    />
  )
}

export function ComposerSubmit({
  disabled,
  ...props
}: Omit<ComponentProps<typeof ButtonPrimitive>, 'type' | 'className' | 'style' | 'render'>): ReactElement {
  const editor = useComposerEditorContext()
  const defaultProps = {
    'data-slot': 'composer-submit',
    type: 'button' as const,
    disabled: disabled ?? !editor?.canSubmit,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>): void => {
      const input = editor?.rootRef.current?.querySelector('[data-slot="composer-input"]')
      if (event.button === 0 && input === event.currentTarget.ownerDocument.activeElement) event.preventDefault()
    },
    onClick: (event: MouseEvent<HTMLButtonElement>): void => {
      if (event.defaultPrevented || disabled) return
      event.preventDefault()
      editor?.submit()
    },
  }
  return (
    <ButtonPrimitive
      {...(mergeProps<'button'>(defaultProps, props as ComponentProps<'button'>) as ComponentProps<
        typeof ButtonPrimitive
      >)}
      {...stylex.props(styles.submit, focusRing.ring)}
    />
  )
}

export {
  type ComposerChangeDetails,
  type ComposerItemValue,
  type ComposerPart,
  type ComposerQuery,
  type ComposerTokenPart,
  type ComposerTrigger,
  type ComposerValue,
  getComposerText,
  useComposerContext,
  useComposerFilter,
} from './composer-editor'
