import { z } from 'zod'

export const CANGYUAN_PRICING_URL = 'https://ai.cangyuansuanli.cn/api/pricing'
export const CANGYUAN_STATUS_URL = 'https://ai.cangyuansuanli.cn/api/status'

const pricingItemSchema = z.object({
  model_name: z.string().trim().min(1),
  model_price: z.number().finite().nonnegative(),
  quota_type: z.number().int(),
  billing_mode: z.string().optional(),
  request_unit: z.string().optional(),
  tags: z.string().optional(),
  supported_endpoint_types: z.array(z.string()).optional(),
  model_ratio: z.number().finite().nonnegative().optional(),
  completion_ratio: z.number().finite().nonnegative().optional(),
  cache_ratio: z.number().finite().nonnegative().optional(),
  enable_groups: z.array(z.string()).optional(),
}).passthrough()

const pricingResponseSchema = z.object({
  success: z.boolean(),
  pricing_version: z.string().trim().min(1),
  data: z.array(pricingItemSchema),
  group_ratio: z.record(z.number().finite().nonnegative()).default({}),
}).passthrough()

const statusResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    quota_per_unit: z.number().finite().positive(),
    quota_display_type: z.string().default('CNY'),
  }).passthrough(),
}).passthrough()

export type CangyuanPricingItem = z.infer<typeof pricingItemSchema>
export type CangyuanPricingPayload = z.infer<typeof pricingResponseSchema>
export type CangyuanStatusPayload = z.infer<typeof statusResponseSchema>

export function parseCangyuanPricingPayload(value: unknown) {
  const parsed = pricingResponseSchema.parse(value)
  if (!parsed.success) throw new Error('CANGYUAN_PRICING_UNSUCCESSFUL')
  return parsed
}

export function parseCangyuanStatusPayload(value: unknown) {
  const parsed = statusResponseSchema.parse(value)
  if (!parsed.success) throw new Error('CANGYUAN_STATUS_UNSUCCESSFUL')
  return parsed
}

export function findCangyuanRequestPrice(
  payload: CangyuanPricingPayload,
  model: string,
) {
  const item = findCangyuanMediaPrice(payload, model)
  return item?.billing_mode === 'per_request' ? item : null
}

export function findCangyuanMediaPrice(
  payload: CangyuanPricingPayload,
  model: string,
) {
  const normalized = model.trim().toLocaleLowerCase()
  const item = payload.data.find((candidate) => (
    candidate.model_name.toLocaleLowerCase() === normalized
  ))
  if (!item) return null
  if (item.quota_type !== 1 || !['per_request', 'per_second'].includes(item.billing_mode || '')) return null
  if (!item.request_unit) return null
  return item
}

export function findCangyuanTokenPrice(
  payload: CangyuanPricingPayload,
  model: string,
  quotaPerUnit: number,
) {
  const normalized = model.trim().toLocaleLowerCase()
  const item = payload.data.find((candidate) => (
    candidate.model_name.toLocaleLowerCase() === normalized
  ))
  if (!item || item.quota_type !== 0 || !item.model_ratio || !item.completion_ratio) return null
  const groupRatios = (item.enable_groups || [])
    .map((group) => payload.group_ratio[group])
    .filter((ratio): ratio is number => typeof ratio === 'number' && ratio > 0)
  const groupRatio = groupRatios.length > 0 ? Math.min(...groupRatios) : 1
  const basePerMillion = 1_000_000 / quotaPerUnit
  const inputPerMillion = item.model_ratio * groupRatio * basePerMillion
  return {
    item,
    groupRatio,
    inputPerMillion,
    outputPerMillion: inputPerMillion * item.completion_ratio,
    cachedInputPerMillion: inputPerMillion * (item.cache_ratio ?? 1),
  }
}

export function pricingItemTaskType(item: CangyuanPricingItem) {
  const endpoints = (item.supported_endpoint_types || []).join(',').toLocaleLowerCase()
  if (/video/u.test(endpoints)) return 'video' as const
  if (/image/u.test(endpoints)) return 'image' as const
  if (/audio|music/u.test(endpoints)) return 'audio' as const
  const tags = (item.tags || '').toLocaleLowerCase()
  if (/video/u.test(tags)) return 'video' as const
  if (/image/u.test(tags)) return 'image' as const
  if (/audio|music/u.test(tags)) return 'audio' as const
  return null
}
