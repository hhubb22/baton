import * as stylex from '@stylexjs/stylex'
import { Streamdown, type Components } from 'streamdown'
import { fonts } from '../theme/base.stylex'
import { colors, radius, space } from '../theme/tokens.stylex'
import { focusRing } from '../ui/Button'
import { markdownComponents, safeLinkUrl } from './RestrictedMarkdown'

const styles = stylex.create({
  body: { minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' },
  code: {
    fontFamily: fonts.mono,
    fontSize: '0.92em',
    paddingInline: space.xxs,
    borderRadius: radius.sm,
    backgroundColor: colors.subtle,
  },
  path: {
    fontFamily: fonts.mono,
    fontSize: '0.92em',
    paddingInline: space.xxs,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: colors.subtle, ':hover': colors.hover },
    color: colors.accentText,
    cursor: 'pointer',
  },
})

const isPath = (value: string) => /^(\/|~\/|[A-Za-z]:\\)/.test(value)

export function MessageBody({
  body,
  onOpenPath,
  streaming = false,
}: {
  body: string
  onOpenPath: (path: string) => void
  streaming?: boolean
}) {
  const components: Components = {
    ...markdownComponents,
    inlineCode: ({ children }) => {
      if (typeof children === 'string' && isPath(children)) {
        return (
          <button type="button" onClick={() => onOpenPath(children)} {...stylex.props(styles.path, focusRing.ring)}>
            {children}
          </button>
        )
      }
      return <code {...stylex.props(styles.code)}>{children}</code>
    },
    img: () => null,
  }
  return (
    <div {...stylex.props(styles.body)}>
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        skipHtml
        urlTransform={safeLinkUrl}
        components={components}
        controls={false}
      >
        {body}
      </Streamdown>
    </div>
  )
}
