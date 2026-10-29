import { useEffect, useRef, useState } from 'react'
import { desktopErrorMessage, useLocalDesktop } from '../data/desktop'
import type { Location } from '../data/derive'
import { useClient } from '../data/queries'

export function useLocalDirectoryPicker({
  nodeId,
  onSelect,
  onError,
}: {
  nodeId: string | null
  onSelect: (location: Location) => void
  onError: (error: string | null) => void
}) {
  const { bridge } = useLocalDesktop(nodeId, 'pick-directory')
  const client = useClient()
  const [pending, setPending] = useState(false)
  const current = useRef({ active: false })
  useEffect(() => {
    const request = { active: true }
    current.current = request
    return () => {
      request.active = false
    }
  }, [nodeId, bridge])
  const available = !!bridge?.pickDirectory && nodeId !== null
  const pick = async () => {
    if (pending || !bridge?.pickDirectory || !nodeId) return
    setPending(true)
    const request = current.current
    const active = () => request.active
    try {
      const path = await bridge.pickDirectory!({ nodeId })
      if (path === null || !active()) return
      const listing = await client.listFolders(nodeId, path)
      if (!active()) return
      if (listing.state === 'ready') {
        onError(null)
        onSelect({ deviceId: nodeId, folder: listing.path ?? path })
      } else {
        const reasons = {
          outsideFolders: '所选文件夹不在此设备允许访问的范围内。',
          offline: '设备已离线，请在设备上线后重试。',
          syncing: '设备正在同步，请稍后重试。',
          missing: '所选文件夹不存在或无法读取。',
        }
        onError(reasons[listing.reason])
      }
    } catch (cause) {
      if (active()) onError(desktopErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }
  return { available, pick, label: pending ? '正在检查文件夹…' : '选择本地文件夹…' }
}
