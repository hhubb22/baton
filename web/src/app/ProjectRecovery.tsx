import { useState } from 'react'
import { ClientError } from '../data/client'
import { useRetryProject } from '../data/queries'
import type { Project } from '../data/types'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'

export function ProjectRecovery({ project }: { project: Project }) {
  const retry = useRetryProject()
  const [error, setError] = useState<string | null>(null)
  return (
    <Banner
      icon="alert"
      title={project.agent.reason ?? 'The project assistant needs attention'}
      detail={error ?? undefined}
      action={
        <Button
          small
          onClick={() => {
            if (retry.isPending) return
            setError(null)
            retry.mutate(project.id, {
              onError: (cause) => setError(cause instanceof ClientError ? cause.message : "Couldn't retry. Try again."),
            })
          }}
        >
          {retry.isPending ? 'Retrying…' : 'Retry'}
        </Button>
      }
    />
  )
}
