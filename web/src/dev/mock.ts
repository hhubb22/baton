import { createMockClient, type MockClient } from '../data/mock/client'
import { isScenarioId, type ScenarioId } from '../data/mock/scenarios'

const storageKey = 'baton.mock.scenario'

// 打开页面时的场景：地址栏 `?scenario=` 优先，其次是上次在场景面板里选的，默认 normal。
export function initialScenario(): ScenarioId {
  const fromUrl = new URLSearchParams(window.location.search).get('scenario')
  if (isScenarioId(fromUrl)) return fromUrl
  try {
    const saved = localStorage.getItem(storageKey)
    if (isScenarioId(saved)) return saved
  } catch {
    // 读不到存储时用默认场景。
  }
  return 'normal'
}

export function rememberScenario(id: ScenarioId) {
  try {
    localStorage.setItem(storageKey, id)
  } catch {
    // 存不下时只影响下次打开的默认场景。
  }
  const url = new URL(window.location.href)
  url.searchParams.set('scenario', id)
  window.history.replaceState(window.history.state, '', url)
}

export function createBrowserClient(): MockClient {
  return createMockClient(initialScenario())
}
