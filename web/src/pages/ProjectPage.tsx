import * as stylex from '@stylexjs/stylex'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Column, Page } from '../app/Page'
import { ThreadRow } from '../app/ThreadRow'
import { pendingInbox, projectAgentStatus } from '../data/derive'
import { useDevices, useInbox, useProjects, useThreads } from '../data/queries'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { StatusPill } from '../ui/Status'

const styles = stylex.create({
  title: { display: 'flex', alignItems: 'center', gap: space.sm },
  section: { display: 'flex', flexDirection: 'column', gap: space.xxs },
  heading: { color: colors.muted, paddingInline: space.md },
  empty: { color: colors.faint, paddingInline: space.md },
})

export function ProjectPage() {
  const { projectId } = useParams({ from: '/workspace/projects/$projectId' })
  const navigate = useNavigate()
  const projects = useProjects()
  const devices = useDevices()
  const threads = useThreads()
  const inbox = useInbox()

  const project = projects.data?.find((item) => item.id === projectId)
  if (projects.data && !project) {
    return (
      <Page title="Project not found">
        <Column>
          <p {...stylex.props(text.body, text.muted)}>This project was deleted or you no longer have access.</p>
        </Column>
      </Page>
    )
  }
  if (!project) return null

  const status = projectAgentStatus(project, devices.data ?? [])
  const pending = pendingInbox(inbox.data ?? [], project.id)
  const projectThreads = (threads.data ?? []).filter((thread) => thread.projectId === project.id)

  return (
    <Page
      title={
        <span {...stylex.props(styles.title)}>
          <Avatar name={project.name} hue={project.hue} />
          {project.name}
        </span>
      }
      actions={<StatusPill tone={status.tone}>{status.label}</StatusPill>}
    >
      <Column>
        {project.agent.state === 'waitingDevice' && (
          <Banner
            title="Project assistant is waiting for a device"
            detail={project.agent.reason ? `Needs: ${project.agent.reason}` : undefined}
          />
        )}
        {pending.length > 0 && (
          <Banner
            attention
            title={`${pending.length} ${pending.length === 1 ? 'decision needs' : 'decisions need'} you`}
            action={
              <Button small onClick={() => void navigate({ to: '/inbox' })}>
                Open Inbox
              </Button>
            }
          />
        )}
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(text.captionMedium, styles.heading)}>Threads</h2>
          {projectThreads.length === 0 && <p {...stylex.props(text.small, styles.empty)}>No threads yet</p>}
          {projectThreads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} device={devices.data?.find((item) => item.id === thread.deviceId)} />
          ))}
        </section>
      </Column>
    </Page>
  )
}
