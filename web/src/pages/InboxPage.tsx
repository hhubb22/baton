import * as stylex from '@stylexjs/stylex'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Column, Page } from '../app/Page'
import { ClientError } from '../data/client'
import { operationLabel, pendingInbox } from '../data/derive'
import { useAnswerItem, useInbox, useOperation, useProjects } from '../data/queries'
import type { InboxItem, Project } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

const styles = stylex.create({
  head: { display: 'flex', alignItems: 'center', gap: space.sm },
  project: { color: colors.muted, textDecoration: 'none' },
  options: { display: 'flex', flexWrap: 'wrap', gap: space.sm },
  status: { color: colors.muted },
  empty: { paddingBlock: space.xl, textAlign: 'center' },
})

function ItemCard({ item, project }: { item: InboxItem; project: Project | undefined }) {
  const answer = useAnswerItem()
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const operation = useOperation(operationId)
  const phase = operation.data ? operationLabel(operation.data, undefined) : null

  const choose = (option: string) => {
    setError(null)
    answer.mutate(
      { itemId: item.id, answer: option, revision: item.revision },
      {
        onSuccess: (result) => setOperationId(result.id),
        onError: (cause) => setError(cause instanceof ClientError ? cause.message : 'Could not save. Try again.'),
      },
    )
  }

  return (
    <Card label={item.title}>
      <div {...stylex.props(styles.head)}>
        {project && <Avatar name={project.name} hue={project.hue} />}
        {project && (
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            {...stylex.props(text.caption, styles.project)}
          >
            {project.name}
          </Link>
        )}
      </div>
      <h2 {...stylex.props(text.heading)}>{item.title}</h2>
      <p {...stylex.props(text.body, text.muted)}>{item.body}</p>
      {item.status === 'pending' && item.options.length > 0 && (
        <div {...stylex.props(styles.options)}>
          {item.options.map((option) => (
            <Button key={option} small onClick={() => choose(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      {(error ?? phase) && (
        <span role="status" {...stylex.props(text.caption, error ? text.danger : styles.status)}>
          {error ?? phase}
        </span>
      )}
    </Card>
  )
}

// 等你决定的事项：在这里回答和在 Project 里回答是同一个对象，任何一处处理后两边一起更新。
export function InboxPage() {
  const inbox = useInbox()
  const projects = useProjects()
  const pending = pendingInbox(inbox.data ?? [])
  return (
    <Page title="Inbox">
      <Column>
        {inbox.data && pending.length === 0 && (
          <p {...stylex.props(text.body, text.muted, styles.empty)}>Nothing needs your decision</p>
        )}
        {pending.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            project={projects.data?.find((project) => project.id === item.projectId)}
          />
        ))}
      </Column>
    </Page>
  )
}
