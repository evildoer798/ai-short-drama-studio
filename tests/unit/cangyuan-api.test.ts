import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CANGYUAN_DIRECT_API_BASE_URL,
  isCangyuanApiBaseUrl,
  preferCangyuanDirectApiBaseUrl,
} from '@/lib/cangyuan-api'

describe('Cangyuan API routing', () => {
  it('prefers the configured HTTP direct endpoint for a legacy Cangyuan URL', () => {
    expect(preferCangyuanDirectApiBaseUrl('https://ai.cangyuansuanli.cn/')).toBe(
      DEFAULT_CANGYUAN_DIRECT_API_BASE_URL,
    )
  })

  it('preserves an API path while switching hosts and protocols', () => {
    expect(preferCangyuanDirectApiBaseUrl('https://ai.cangyuansuanli.cn/v1/')).toBe(
      'http://direct-api.cangyuansuanli.cn/v1',
    )
    expect(preferCangyuanDirectApiBaseUrl('https://direct-api.cangyuansuanli.cn/v1')).toBe(
      'http://direct-api.cangyuansuanli.cn/v1',
    )
  })

  it('leaves non-Cangyuan providers unchanged', () => {
    expect(preferCangyuanDirectApiBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com')
    expect(preferCangyuanDirectApiBaseUrl('https://sub.kedaya.xyz/v1')).toBe('https://sub.kedaya.xyz/v1')
    expect(isCangyuanApiBaseUrl('https://sub.kedaya.xyz/v1')).toBe(false)
  })

  it('allows an explicit direct endpoint override', () => {
    expect(preferCangyuanDirectApiBaseUrl(
      'https://ai.cangyuansuanli.cn/v1',
      'http://127.0.0.1:8080',
    )).toBe('http://127.0.0.1:8080/v1')
  })
})
