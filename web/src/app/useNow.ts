import { useEffect, useState } from 'react'

// 当前时间，每隔 interval 毫秒刷新一次；interval 为 null 时不刷新。
export function useNow(interval: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (interval === null) return
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  return now
}
