export const DEFAULT_CANGYUAN_DIRECT_API_BASE_URL = 'http://direct-api.cangyuansuanli.cn'

function normalizedBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '')
}

export function isCangyuanApiBaseUrl(value: string) {
  try {
    return new URL(value).hostname.toLowerCase().endsWith('.cangyuansuanli.cn')
  } catch {
    return false
  }
}

export function preferCangyuanDirectApiBaseUrl(
  configuredBaseUrl: string,
  directBaseUrl = DEFAULT_CANGYUAN_DIRECT_API_BASE_URL,
) {
  const configured = normalizedBaseUrl(configuredBaseUrl)
  if (!isCangyuanApiBaseUrl(configured)) return configured

  try {
    const source = new URL(configured)
    const direct = new URL(normalizedBaseUrl(directBaseUrl))
    if ((direct.pathname === '/' || !direct.pathname) && source.pathname !== '/') {
      direct.pathname = source.pathname
    }
    if (!direct.search && source.search) direct.search = source.search
    return normalizedBaseUrl(direct.toString())
  } catch {
    return configured
  }
}
