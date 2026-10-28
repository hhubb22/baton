import * as stylex from '@stylexjs/stylex'
import { Link } from '@tanstack/react-router'
import { Column, Page } from '../app/Page'
import { useProjects } from '../data/queries'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.md,
    color: colors.text,
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
    <Page title="Archived projects">
      <Column>
        {projects.isPending && (
          <p role="status" {...stylex.props(text.small, text.muted)}>
            Loading projects…
          </p>
        )}
        {projects.isError && (
          <Banner
            icon="alert"
            title="Couldn't load archived projects"
            action={
              <Button small onClick={() => void projects.refetch()}>
                Retry
              </Button>
            }
          />
        )}
        {projects.data && archived.length === 0 && (
          <p {...stylex.props(text.small, text.muted)}>No archived projects</p>
        )}
        {archived.map((project) => (
          <Link
            key={project.id}
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            {...stylex.props(styles.row, focusRing.ring)}
          >
            <Avatar name={project.name} hue={project.hue} />
            <span {...stylex.props(styles.content)}>
              <span {...stylex.props(text.bodyMedium, text.truncate)}>{project.name}</span>
              <span {...stylex.props(text.caption, text.muted)}>
                Archived{project.archivedAt && ` · ${new Date(project.archivedAt).toLocaleString()}`}
              </span>
            </span>
          </Link>
        ))}
      </Column>
    </Page>
  )
}
