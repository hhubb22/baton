import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import type { MockControls } from '../data/mock/client'
import { scenarioIds, scenarioLabels, type ScenarioId } from '../data/mock/scenarios'
import { useDevices, useSession } from '../data/queries'
import { shadow } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Button, IconButton } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { rememberScenario } from './mock'

const styles = stylex.create({
  panel: {
    position: 'fixed',
    right: space.lg,
    bottom: space.lg,
    zIndex: 40,
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    width: '260px',
    padding: space.md,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.lg,
    boxShadow: shadow.menu,
  },
  collapsed: {
    position: 'fixed',
    right: space.lg,
    bottom: space.lg,
    zIndex: 40,
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  select: {
    flexGrow: 1,
    height: '28px',
    paddingInline: space.sm,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: 'inherit',
    fontSize: '13px',
  },
  devices: { display: 'flex', flexDirection: 'column', gap: space.xs },
})

// 只在开发服务器里出现：切换和重置模拟场景，手动让设备上下线、结束会话或断开与 Baton 的连接。
export function ScenarioPanel({ controls }: { controls: MockControls }) {
  const [open, setOpen] = useState(false)
  const [scenario, setScenario] = useState<ScenarioId>(controls.scenario)
  const [reachable, setReachable] = useState(controls.reachable)
  const devices = useDevices()
  const session = useSession()

  if (!open) {
    return (
      <div {...stylex.props(styles.collapsed)}>
        <Button small icon="settings" onClick={() => setOpen(true)}>
          Scenario
        </Button>
      </div>
    )
  }

  const switchTo = (id: ScenarioId) => {
    setScenario(id)
    rememberScenario(id)
    controls.reset(id)
  }

  return (
    <aside aria-label="Mock scenario" {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(text.label)}>Mock scenario</span>
        <IconButton icon="close" label="Hide scenario panel" onClick={() => setOpen(false)} />
      </div>
      <div {...stylex.props(styles.row)}>
        <select
          aria-label="Scenario"
          value={scenario}
          onChange={(event) => switchTo(event.target.value as ScenarioId)}
          {...stylex.props(styles.select)}
        >
          {scenarioIds.map((id) => (
            <option key={id} value={id}>
              {scenarioLabels[id]}
            </option>
          ))}
        </select>
        <Button small icon="refresh" onClick={() => controls.reset(scenario)}>
          Reset
        </Button>
      </div>
      <div {...stylex.props(styles.row, text.small)}>
        <span>Baton reachable</span>
        <Toggle
          label="Baton reachable"
          checked={reachable}
          onChange={(next) => {
            setReachable(next)
            controls.setReachable(next)
          }}
        />
      </div>
      {session.data?.account && (
        <div {...stylex.props(styles.row)}>
          <Button small onClick={() => controls.endSession('expired')}>
            Expire sign-in
          </Button>
          <Button small onClick={() => controls.endSession('passwordReset')}>
            Reset password
          </Button>
        </div>
      )}
      {devices.data && devices.data.length > 0 && (
        <div {...stylex.props(styles.devices)}>
          {devices.data.map((device) => (
            <div key={device.id} {...stylex.props(styles.row, text.small)}>
              <span {...stylex.props(text.truncate)}>{device.name}</span>
              <Toggle
                label={`${device.name} online`}
                checked={device.connection === 'online'}
                onChange={(online) => controls.setDeviceConnection(device.id, online ? 'online' : 'offline')}
              />
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
