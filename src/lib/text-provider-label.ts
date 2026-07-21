export const TEXT_PROVIDER_LABELS = [
  'DeepSeek',
  'Cangyuan',
  'Kedaya',
  'Custom',
] as const

export type TextProviderLabel = (typeof TEXT_PROVIDER_LABELS)[number]

export function isTextProviderLabel(value: unknown): value is TextProviderLabel {
  return TEXT_PROVIDER_LABELS.includes(value as TextProviderLabel)
}

export function textProviderLabel(baseUrl: string): TextProviderLabel {
  let hostname = baseUrl.toLowerCase()
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    // A malformed custom URL is still represented safely in progress details.
  }
  if (hostname.includes('deepseek')) return 'DeepSeek'
  if (hostname.includes('cangyuansuanli')) return 'Cangyuan'
  if (hostname.includes('kedaya')) return 'Kedaya'
  return 'Custom'
}
