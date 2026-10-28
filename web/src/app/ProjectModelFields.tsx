import * as stylex from '@stylexjs/stylex'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { assistantModels } from '../data/derive'
import { useClient, useDevices } from '../data/queries'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Button, focusRing } from '../ui/Button'
import { Field, Input } from '../ui/Field'

type Catalog = { provider: string; models: string[]; sourceNodeId?: string | null; label?: string }[]
type Selection = { subscription: string; model: string; sourceNodeId?: string | null }

const styles = stylex.create({
  fields: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: space.md },
  section: { display: 'flex', flexDirection: 'column', gap: space.sm },
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
  link: { color: colors.accent },
  action: { alignSelf: 'flex-start' },
})

export function useProjectModelCatalog() {
  const client = useClient()
  const devices = useDevices()
  const [completeModels, setCompleteModels] = useState<Record<string, string[]>>({})
  useEffect(() => {
    let active = true
    const truncated = (devices.data ?? []).flatMap((device) =>
      (device.modelConnections ?? [])
        .filter((connection) => connection.modelsTruncated && device.connection === 'online')
        .map((connection) => ({ device, connection })),
    )
    void Promise.all(
      truncated.map(async ({ device, connection }) => {
        try {
          const complete = await client.configureModelConnection({ deviceId: device.id, action: 'get', connection })
          return complete ? ([`${device.id}|${connection.id}`, complete.models] as const) : null
        } catch {
          return null
        }
      }),
    ).then((results) => {
      if (active) setCompleteModels(Object.fromEntries(results.filter((item) => item !== null)))
    })
    return () => {
      active = false
    }
  }, [client, devices.data])
  const providers = new Map<string, Set<string>>()
  for (const device of devices.data ?? []) {
    if (!device.hasRuntime) continue
    for (const subscription of device.subscriptions) {
      const models = providers.get(subscription.provider) ?? new Set<string>()
      for (const model of subscription.models ?? []) if (model) models.add(model)
      providers.set(subscription.provider, models)
    }
  }
  if (client.mode === 'mock') {
    for (const [provider, models] of Object.entries(assistantModels)) {
      if (!providers.get(provider)?.size) providers.set(provider, new Set(models))
    }
  }
  const catalog: Catalog = [...providers]
    .filter(([, models]) => models.size > 0)
    .map(([provider, models]) => ({ provider, models: [...models] }))
  for (const device of devices.data ?? []) {
    for (const connection of device.modelConnections ?? []) {
      catalog.push({
        provider: `api-${connection.id}`,
        sourceNodeId: device.id,
        label: `${connection.name} · ${device.name}`,
        models: completeModels[`${device.id}|${connection.id}`] ?? connection.models,
      })
    }
  }
  return { catalog, devices }
}

export function ProjectModelFields({
  catalog,
  value,
  onChange,
  onCommit,
  creating = false,
  readOnly = false,
  loading = false,
}: {
  catalog: Catalog
  value: Selection
  onChange: (value: Selection) => void
  onCommit?: () => void
  creating?: boolean
  readOnly?: boolean
  loading?: boolean
}) {
  const [manual, setManual] = useState(false)
  const listed = catalog.some(
    (item) =>
      item.provider === value.subscription &&
      (item.sourceNodeId ?? null) === (value.sourceNodeId ?? null) &&
      item.models.includes(value.model),
  )
  const custom = manual || (!listed && Boolean(value.subscription || value.model))
  const missingConnection = !!value.sourceNodeId && value.subscription.startsWith('api-') && !listed
  const connectionLabel = catalog.find(
    (item) => item.provider === value.subscription && item.sourceNodeId === value.sourceNodeId,
  )?.label
  const providerLabel = 'Model source'
  const modelLabel = creating ? 'Model' : 'Project assistant model'
  const models =
    catalog.find(
      (item) => item.provider === value.subscription && (item.sourceNodeId ?? null) === (value.sourceNodeId ?? null),
    )?.models ?? []

  return (
    <div {...stylex.props(styles.section)}>
      {!readOnly && catalog.length === 0 && (
        <p {...stylex.props(text.caption, text.muted)}>
          {loading ? 'Loading models…' : 'No models from your devices.'}{' '}
          <Link to="/devices" search={{ connect: true }} {...stylex.props(styles.link)}>
            Connect a device
          </Link>
        </p>
      )}
      {missingConnection && (
        <p {...stylex.props(text.caption, text.muted)}>
          This API connection is unavailable on its device. Choose another model source to resume.
        </p>
      )}
      {(readOnly || custom || catalog.length > 0) && (
        <div
          {...stylex.props(styles.fields)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) onCommit?.()
          }}
        >
          <Field
            label={providerLabel}
            helper={custom && !readOnly ? 'Provider ID, for example openai-codex or xai.' : undefined}
          >
            {(props) =>
              readOnly || custom ? (
                <Input
                  {...props}
                  value={
                    missingConnection
                      ? 'API connection unavailable'
                      : readOnly && value.sourceNodeId
                        ? (connectionLabel ?? 'API connection unavailable')
                        : value.subscription
                  }
                  readOnly={readOnly || missingConnection}
                  placeholder="Provider ID"
                  onChange={(event) => {
                    setManual(true)
                    onChange({ ...value, subscription: event.target.value, sourceNodeId: null })
                  }}
                />
              ) : (
                <select
                  {...props}
                  value={`${value.sourceNodeId ?? ''}|${value.subscription}`}
                  onChange={(event) => {
                    const item = catalog.find(
                      (entry) => `${entry.sourceNodeId ?? ''}|${entry.provider}` === event.target.value,
                    )!
                    onChange({
                      subscription: item.provider,
                      sourceNodeId: item.sourceNodeId ?? null,
                      model: item.models[0],
                    })
                    onCommit?.()
                  }}
                  {...stylex.props(text.small, styles.select, focusRing.ring)}
                >
                  <optgroup label="Subscriptions">
                    {catalog
                      .filter((item) => !item.sourceNodeId)
                      .map((item) => (
                        <option key={item.provider} value={`|${item.provider}`}>
                          {item.provider}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="API connections">
                    {catalog
                      .filter((item) => item.sourceNodeId)
                      .map((item) => (
                        <option
                          key={`${item.sourceNodeId}|${item.provider}`}
                          value={`${item.sourceNodeId}|${item.provider}`}
                        >
                          {item.label}
                        </option>
                      ))}
                  </optgroup>
                </select>
              )
            }
          </Field>
          <Field label={modelLabel}>
            {(props) =>
              readOnly || custom ? (
                <Input
                  {...props}
                  value={value.model}
                  readOnly={readOnly}
                  placeholder="Model ID"
                  onChange={(event) => {
                    setManual(true)
                    onChange({ ...value, model: event.target.value })
                  }}
                />
              ) : (
                <select
                  {...props}
                  value={value.model}
                  onChange={(event) => {
                    onChange({ ...value, model: event.target.value })
                    onCommit?.()
                  }}
                  {...stylex.props(text.small, styles.select, focusRing.ring)}
                >
                  {models.map((model) => (
                    <option key={model}>{model}</option>
                  ))}
                </select>
              )
            }
          </Field>
        </div>
      )}
      {!readOnly && (
        <div {...stylex.props(styles.action)}>
          {custom && catalog.length > 0 ? (
            <Button
              small
              onClick={() => {
                setManual(false)
                onChange({
                  subscription: catalog[0].provider,
                  sourceNodeId: catalog[0].sourceNodeId ?? null,
                  model: catalog[0].models[0],
                })
                onCommit?.()
              }}
            >
              Choose from device models
            </Button>
          ) : !custom ? (
            <Button small onClick={() => setManual(true)}>
              Enter provider and model manually
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
