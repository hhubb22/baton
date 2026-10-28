import * as stylex from '@stylexjs/stylex'
import { useEffect, useState } from 'react'
import { useClient, useProjects } from '../data/queries'
import { desktopCapability, useDesktopStatus } from '../data/desktop'
import type { Device, ModelConnection } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Button, focusRing } from '../ui/Button'
import { Field, Input, TextArea } from '../ui/Field'

const styles = stylex.create({
  section: { display: 'flex', flexDirection: 'column', gap: space.md, width: '100%', maxWidth: '560px' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space.sm },
  back: { alignSelf: 'flex-start' },
  delete: { marginRight: 'auto' },
  error: { color: colors.danger },
  select: {
    width: '100%',
    height: size.control,
    paddingInline: '10px',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: colors.border, ':focus': colors.focus },
    borderRadius: radius.sm,
    outline: 'none',
    color: colors.text,
  },
})

export function ModelConnectionEditor({
  device,
  initial,
  onBack,
}: {
  device: Device
  initial?: ModelConnection
  onBack: () => void
}) {
  const client = useClient()
  const projects = useProjects()
  const desktop = useDesktopStatus()
  const [connection, setConnection] = useState<ModelConnection>(
    () =>
      initial ?? {
        id: crypto.randomUUID(),
        name: '',
        protocol: 'openai-responses',
        base_url: 'https://api.openai.com/v1',
        models: [],
        keyNeeded: true,
      },
  )
  const [models, setModels] = useState(connection.models.join('\n'))
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    if (!initial?.modelsTruncated) return
    let active = true
    void client
      .configureModelConnection({ deviceId: device.id, action: 'get', connection: initial })
      .then((complete) => {
        if (!active) return
        if (!complete) throw new Error('connection_missing')
        setConnection((current) => ({ ...current, models: complete.models, modelsTruncated: false }))
        setModels(complete.models.join('\n'))
      })
      .catch(() => {
        if (active) setError('Could not load the complete model list. Reconnect the device and try again.')
      })
    return () => {
      active = false
    }
  }, [client, device.id, initial])
  const local =
    desktop.data?.registered &&
    desktop.data.node_id === device.id &&
    !!desktopCapability('model-connection-key')?.setModelConnectionKey
  const affected = (projects.data ?? []).filter(
    (project) => project.sourceNodeId === device.id && project.subscription === `api-${connection.id}`,
  )
  const base = connection.base_url.replace(/\/+$/, '')
  const path =
    connection.protocol === 'anthropic-messages'
      ? `${base.endsWith('/v1') ? base.slice(0, -3) : base}/v1/messages?beta=true`
      : `${base}/${connection.protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`
  const run = async (action: 'save' | 'delete') => {
    setSaving(true)
    setError('')
    try {
      const value = {
        ...connection,
        name: connection.name.trim(),
        base_url: connection.base_url.trim(),
        models: models
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
      }
      await client.configureModelConnection({ deviceId: device.id, action, connection: value })
      if (action === 'save' && key && local)
        await desktop.bridge!.setModelConnectionKey!({ nodeId: device.id, connectionId: value.id, key })
      setKey('')
      onBack()
    } catch {
      setError('Could not save the connection. Check the fields and device status, then try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <section {...stylex.props(styles.section)}>
      <Button small variant="ghost" style={styles.back} onClick={onBack}>
        Back to {device.name}
      </Button>
      <h3 {...stylex.props(text.title)}>{initial ? 'Edit API connection' : 'Add API connection'}</h3>
      <p {...stylex.props(text.caption, text.muted)}>Each device can store up to 29 API connections.</p>
      <Field label="Name">
        {(props) => (
          <Input
            {...props}
            value={connection.name}
            onChange={(event) => setConnection({ ...connection, name: event.target.value })}
          />
        )}
      </Field>
      <Field label="Protocol">
        {(props) => (
          <select
            {...props}
            {...stylex.props(text.small, styles.select, focusRing.ring)}
            value={connection.protocol}
            onChange={(event) => {
              const protocol = event.target.value as ModelConnection['protocol']
              const official = [
                'https://api.anthropic.com',
                'https://api.anthropic.com/v1',
                'https://api.openai.com/v1',
              ].includes(connection.base_url.replace(/\/+$/, ''))
              setConnection({
                ...connection,
                protocol,
                base_url: official
                  ? protocol === 'anthropic-messages'
                    ? 'https://api.anthropic.com'
                    : 'https://api.openai.com/v1'
                  : connection.base_url,
              })
            }}
          >
            <option value="openai-responses">OpenAI Responses</option>
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
        )}
      </Field>
      <Field label="Base URL">
        {(props) => (
          <Input
            {...props}
            value={connection.base_url}
            onChange={(event) => setConnection({ ...connection, base_url: event.target.value })}
          />
        )}
      </Field>
      <p {...stylex.props(text.caption, text.muted)}>Request URL: {path}</p>
      <Field label="Model IDs" helper="One model ID per line.">
        {(props) => (
          <TextArea
            {...props}
            value={models}
            readOnly={connection.modelsTruncated}
            onChange={(event) => setModels(event.target.value)}
          />
        )}
      </Field>
      {connection.modelsTruncated && (
        <p role="alert" {...stylex.props(text.small, styles.error)}>
          Loading the complete model list from this device is required before saving changes.
        </p>
      )}
      {local ? (
        <Field label="API key" helper="Leave blank to keep the saved key.">
          {(props) => <Input {...props} type="password" value={key} onChange={(event) => setKey(event.target.value)} />}
        </Field>
      ) : (
        <p {...stylex.props(text.caption, text.muted)}>
          After saving, on {device.name} run:{' '}
          <code>batond project-runtime connection-key {connection.id} &lt; key-file</code>
        </p>
      )}
      {error && (
        <p role="alert" {...stylex.props(text.small, styles.error)}>
          {error}
        </p>
      )}
      {confirmDelete && (
        <p {...stylex.props(text.small)}>
          Deleting this connection will leave{' '}
          {affected.length ? affected.map((project) => project.name).join(', ') : 'no projects'} waiting for a new model
          source.
        </p>
      )}
      {projects.isError && initial && (
        <p role="alert" {...stylex.props(text.small, styles.error)}>
          Couldn't load projects. Try again before deleting this connection.
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        {initial && (
          <Button
            variant="danger"
            style={styles.delete}
            disabled={saving || !projects.isSuccess}
            onClick={() => (confirmDelete ? void run('delete') : setConfirmDelete(true))}
          >
            {confirmDelete ? 'Confirm delete' : 'Delete connection'}
          </Button>
        )}
        <Button disabled={saving} onClick={onBack}>
          Cancel
        </Button>
        <Button variant="primary" disabled={saving || connection.modelsTruncated} onClick={() => void run('save')}>
          Save connection
        </Button>
      </div>
    </section>
  )
}
