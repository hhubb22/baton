import * as stylex from '@stylexjs/stylex'
import { Link } from '@tanstack/react-router'
import { Column, Page } from '../app/Page'
import { useProjects } from '../data/queries'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.md,
    color: semantic.foreground,
    textDecoration: 'none',
  },
  content: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
})

export function ArchivedProjectsPage() {
  const projects = useProjects()
  const archived = (projects.data ?? [])
    .filter((project) => project.status === 'archived')
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  return (
    <Page title="已归档项目">
      <Column>
        {projects.isPending && (
          <p role="status" {...stylex.props(text.small, text.muted)}>
            正在加载项目…
          </p>
        )}
        {projects.isError && (
          <Banner
            icon="alert"
            title="无法加载已归档项目"
            action={
              <Button small onClick={() => void projects.refetch()}>
                重试
              </Button>
            }
          />
        )}
        {projects.data && archived.length === 0 && <p {...stylex.props(text.small, text.muted)}>暂无已归档项目</p>}
        {archived.map((project) => (
          <Link
            key={project.id}
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            {...stylex.props(styles.row, focusRing.ring)}
          >
            <Avatar name={project.name} hue={project.hue} emoji={project.emoji} />
            <span {...stylex.props(styles.content)}>
              <span {...stylex.props(text.bodyMedium, text.truncate)}>{project.name}</span>
              <span {...stylex.props(text.caption, text.muted)}>
                已归档
                {project.archivedAt && ` · ${new Date(project.archivedAt).toLocaleString('zh-CN', { hour12: false })}`}
              </span>
            </span>
          </Link>
        ))}
      </Column>
    </Page>
  )
}
