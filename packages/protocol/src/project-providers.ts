// 别名只用于输入转换；provider 是否可用由设备上的实现和报告决定。
export function normalizeProjectProvider(value: string): string {
  const id = value.trim()
  const alias = { chatgpt: 'openai-codex', xai: 'xai', claude: 'anthropic' }[id.toLowerCase()]
  const provider = alias ?? id
  if (!/^[a-z0-9-]{1,64}$/.test(provider)) throw new Error('invalid_provider')
  return provider
}
