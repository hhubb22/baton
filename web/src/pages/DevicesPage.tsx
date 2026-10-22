import * as stylex from '@stylexjs/stylex'
import { Column, Page } from '../app/Page'
import { deviceStatus } from '../data/derive'
import { useDevices } from '../data/queries'
import type { Device } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Card } from '../ui/Card'
import { Icon } from '../ui/Icon'
import { StatusPill } from '../ui/Status'

const styles = stylex.create({
  head: { display: 'flex', alignItems: 'center', gap: space.sm },
  name: { flexGrow: 1 },
  meta: { color: colors.muted },
  glyph: { color: colors.muted },
  empty: { paddingBlock: space.xl, textAlign: 'center' },
})

const timeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

function DeviceCard({ device }: { device: Device }) {
  const status = deviceStatus(device)
  const agents = device.agents.map((agent) => (agent.missing ? `${agent.kind} (${agent.missing})` : agent.kind))
  return (
    <Card label={device.name}>
      <div {...stylex.props(styles.head)}>
        <Icon name="laptop" size={16} style={styles.glyph} />
        <h2 {...stylex.props(text.heading, styles.name)}>{device.name}</h2>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </div>
      <span {...stylex.props(text.caption, styles.meta)}>
        {device.os} · {agents.join(', ') || 'No agents'}
        {device.connection !== 'online' && ` · Last seen ${timeFormat.format(device.lastSeenAt)}`}
      </span>
      {device.folders.length > 0 && (
        <span {...stylex.props(text.mono, styles.meta)}>{device.folders.join('  ')}</span>
      )}
    </Card>
  )
}

export function DevicesPage() {
  const devices = useDevices()
  return (
    <Page title="Devices">
      <Column>
        {devices.data?.length === 0 && (
          <p {...stylex.props(text.body, text.muted, styles.empty)}>No devices connected yet</p>
        )}
        {devices.data?.map((device) => <DeviceCard key={device.id} device={device} />)}
      </Column>
    </Page>
  )
}
