import {
  BillingStatus,
  BillingTaskType,
  Prisma,
  type UsageLedger,
} from '@prisma/client'
import { prisma } from './db'
import {
  CANGYUAN_PRICING_URL,
  CANGYUAN_STATUS_URL,
  findCangyuanMediaPrice,
  findCangyuanTokenPrice,
  parseCangyuanPricingPayload,
  parseCangyuanStatusPayload,
  pricingItemTaskType,
  type CangyuanPricingPayload,
} from './cangyuan-pricing'

const PRICING_PROVIDER = 'cangyuan'
const PRICING_TTL_MS = 5 * 60_000

type CatalogState = {
  payload: CangyuanPricingPayload
  quotaPerUnit: number
  currency: string
  fetchedAt: Date
  stale: boolean
}

export type BillableTextUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}

type UsageInput = {
  idempotencyKey: string
  userId: string
  taskType: BillingTaskType
  sourceType: string
  sourceTaskId: string
  model: string
  quantity?: number | string | Prisma.Decimal
  durationSeconds?: number | string | Prisma.Decimal
  occurredAt?: Date
  auditMetadata?: Prisma.InputJsonObject
}

let catalogCache: { expiresAt: number, state: CatalogState } | null = null

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000)
}

function decimal(value: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(value)
}

async function loadSavedCatalog() {
  const saved = await prisma.pricingCatalogSnapshot.findUnique({
    where: { provider: PRICING_PROVIDER },
  })
  if (!saved) return null
  const catalog = saved.catalog && typeof saved.catalog === 'object' && !Array.isArray(saved.catalog)
    ? saved.catalog as Record<string, unknown>
    : {}
  const pricingRaw = catalog.pricing || saved.catalog
  const status = parseCangyuanStatusPayload(catalog.status || {
    success: true,
    data: { quota_per_unit: 500000, quota_display_type: 'CNY' },
  })
  return {
    saved,
    state: {
      payload: parseCangyuanPricingPayload(pricingRaw),
      quotaPerUnit: status.data.quota_per_unit,
      currency: status.data.quota_display_type,
      fetchedAt: saved.fetchedAt,
      stale: Date.now() - saved.fetchedAt.getTime() > PRICING_TTL_MS,
    } satisfies CatalogState,
  }
}

export async function getCangyuanPricingCatalog(options: {
  forceRefresh?: boolean
  fetchImpl?: typeof fetch
  now?: Date
} = {}): Promise<CatalogState> {
  const now = options.now || new Date()
  if (!options.forceRefresh && catalogCache && catalogCache.expiresAt > now.getTime()) {
    return catalogCache.state
  }

  const saved = await loadSavedCatalog().catch(() => null)
  if (!options.forceRefresh && saved && !saved.state.stale) {
    catalogCache = { expiresAt: saved.state.fetchedAt.getTime() + PRICING_TTL_MS, state: saved.state }
    return saved.state
  }

  try {
    const fetchImpl = options.fetchImpl || fetch
    const request = (url: string) => fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    })
    const [pricingResponse, statusResponse] = await Promise.all([
      request(CANGYUAN_PRICING_URL),
      request(CANGYUAN_STATUS_URL),
    ])
    if (!pricingResponse.ok) throw new Error(`CANGYUAN_PRICING_HTTP_${pricingResponse.status}`)
    if (!statusResponse.ok) throw new Error(`CANGYUAN_STATUS_HTTP_${statusResponse.status}`)
    const [raw, statusRaw] = await Promise.all([
      pricingResponse.json() as Promise<unknown>,
      statusResponse.json() as Promise<unknown>,
    ])
    const payload = parseCangyuanPricingPayload(raw)
    const status = parseCangyuanStatusPayload(statusRaw)
    const catalog = { pricing: raw, status: statusRaw } as Prisma.InputJsonValue
    await prisma.pricingCatalogSnapshot.upsert({
      where: { provider: PRICING_PROVIDER },
      create: {
        provider: PRICING_PROVIDER,
        pricingVersion: payload.pricing_version,
        catalog,
        fetchedAt: now,
        lastAttemptedAt: now,
      },
      update: {
        pricingVersion: payload.pricing_version,
        catalog,
        fetchedAt: now,
        lastAttemptedAt: now,
        lastError: null,
      },
    })
    const state = {
      payload,
      quotaPerUnit: status.data.quota_per_unit,
      currency: status.data.quota_display_type,
      fetchedAt: now,
      stale: false,
    }
    catalogCache = { expiresAt: now.getTime() + PRICING_TTL_MS, state }
    return state
  } catch (error) {
    if (saved) {
      await prisma.pricingCatalogSnapshot.update({
        where: { provider: PRICING_PROVIDER },
        data: { lastAttemptedAt: now, lastError: errorMessage(error) },
      }).catch(() => undefined)
      return { ...saved.state, stale: true }
    }
    throw error
  }
}

export async function recordCompletedTextUsage(input: {
  idempotencyKey: string
  userId: string
  sourceTaskId: string
  model: string
  usage: BillableTextUsage
  occurredAt?: Date
}) {
  try {
    const existing = await prisma.usageLedger.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    })
    if (existing?.status === BillingStatus.settled) return existing
    const catalog = await getCangyuanPricingCatalog()
    const price = findCangyuanTokenPrice(catalog.payload, input.model, catalog.quotaPerUnit)
    if (!price) throw new Error(`CANGYUAN_TOKEN_PRICE_NOT_FOUND: ${input.model}`)
    const cachedInputTokens = Math.min(
      Math.max(0, Math.round(input.usage.cachedInputTokens || 0)),
      Math.max(0, Math.round(input.usage.inputTokens)),
    )
    const inputTokens = Math.max(0, Math.round(input.usage.inputTokens))
    const outputTokens = Math.max(0, Math.round(input.usage.outputTokens))
    const regularInputTokens = inputTokens - cachedInputTokens
    const amount = decimal(regularInputTokens).mul(price.inputPerMillion).div(1_000_000)
      .plus(decimal(cachedInputTokens).mul(price.cachedInputPerMillion).div(1_000_000))
      .plus(decimal(outputTokens).mul(price.outputPerMillion).div(1_000_000))
    const totalTokens = decimal(inputTokens + outputTokens)
    const effectiveUnitPrice = totalTokens.isZero()
      ? decimal(0)
      : amount.div(totalTokens)
    const now = input.occurredAt || new Date()
    return await prisma.usageLedger.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        taskType: BillingTaskType.text,
        sourceType: 'generation_task_text_call',
        sourceTaskId: input.sourceTaskId,
        model: price.item.model_name,
        quantity: totalTokens,
        unit: 'token',
        unitPrice: effectiveUnitPrice,
        amount,
        currency: catalog.currency,
        status: BillingStatus.settled,
        pricingVersion: catalog.payload.pricing_version,
        priceSnapshot: {
          catalogVersion: catalog.payload.pricing_version,
          fetchedAt: catalog.fetchedAt.toISOString(),
          stale: catalog.stale,
          quotaPerUnit: catalog.quotaPerUnit,
          groupRatio: price.groupRatio,
          ratesPerMillion: {
            input: price.inputPerMillion,
            cachedInput: price.cachedInputPerMillion,
            output: price.outputPerMillion,
          },
          usage: { inputTokens, cachedInputTokens, outputTokens },
          item: price.item,
        } as Prisma.InputJsonObject,
        occurredAt: now,
        settledAt: now,
      },
      update: {
        model: price.item.model_name,
        quantity: totalTokens,
        unit: 'token',
        unitPrice: effectiveUnitPrice,
        amount,
        currency: catalog.currency,
        status: BillingStatus.settled,
        pricingVersion: catalog.payload.pricing_version,
        priceSnapshot: {
          catalogVersion: catalog.payload.pricing_version,
          fetchedAt: catalog.fetchedAt.toISOString(),
          stale: catalog.stale,
          quotaPerUnit: catalog.quotaPerUnit,
          groupRatio: price.groupRatio,
          ratesPerMillion: {
            input: price.inputPerMillion,
            cachedInput: price.cachedInputPerMillion,
            output: price.outputPerMillion,
          },
          usage: { inputTokens, cachedInputTokens, outputTokens },
          item: price.item,
        } as Prisma.InputJsonObject,
        billingError: null,
        occurredAt: now,
        settledAt: now,
        voidedAt: null,
      },
    })
  } catch (error) {
    const inputTokens = Math.max(0, Math.round(input.usage.inputTokens))
    const outputTokens = Math.max(0, Math.round(input.usage.outputTokens))
    const cachedInputTokens = Math.max(0, Math.round(input.usage.cachedInputTokens || 0))
    const now = input.occurredAt || new Date()
    await prisma.usageLedger.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        taskType: BillingTaskType.text,
        sourceType: 'generation_task_text_call',
        sourceTaskId: input.sourceTaskId,
        model: input.model,
        quantity: decimal(inputTokens + outputTokens),
        unit: 'token',
        status: BillingStatus.pending,
        priceSnapshot: { usage: { inputTokens, outputTokens, cachedInputTokens } },
        billingError: errorMessage(error),
        occurredAt: now,
      },
      update: {
        model: input.model,
        quantity: decimal(inputTokens + outputTokens),
        status: BillingStatus.pending,
        priceSnapshot: { usage: { inputTokens, outputTokens, cachedInputTokens } },
        billingError: errorMessage(error),
        occurredAt: now,
      },
    }).catch((ledgerError) => {
      console.error('TEXT_BILLING_LEDGER_WRITE_FAILED', errorMessage(ledgerError))
    })
    console.error('TEXT_BILLING_FAILED', errorMessage(error))
    return null
  }
}

export async function recordCompletedUsage(input: UsageInput): Promise<UsageLedger | null> {
  try {
    const existing = await prisma.usageLedger.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    })
    if (existing?.status === BillingStatus.settled) return existing
    const catalog = await getCangyuanPricingCatalog()
    const item = findCangyuanMediaPrice(catalog.payload, input.model)
    if (!item) throw new Error(`CANGYUAN_PRICE_NOT_FOUND: ${input.model}`)
    const catalogTaskType = pricingItemTaskType(item)
    if (catalogTaskType && catalogTaskType !== input.taskType) {
      throw new Error(`CANGYUAN_PRICE_TYPE_MISMATCH: ${input.model}`)
    }
    const perSecond = item.billing_mode === 'per_second'
    if (perSecond && input.durationSeconds == null) {
      throw new Error(`CANGYUAN_DURATION_REQUIRED: ${input.model}`)
    }
    const quantity = perSecond
      ? decimal(input.durationSeconds!)
      : decimal(input.quantity || 1)
    if (!quantity.isPositive()) throw new Error(`CANGYUAN_QUANTITY_INVALID: ${input.model}`)
    const unitPrice = decimal(item.model_price)
    const amount = quantity.mul(unitPrice)
    const now = input.occurredAt || new Date()
    return await prisma.usageLedger.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        taskType: input.taskType,
        sourceType: input.sourceType,
        sourceTaskId: input.sourceTaskId,
        model: item.model_name,
        quantity,
        unit: item.request_unit!,
        unitPrice,
        amount,
        status: BillingStatus.settled,
        pricingVersion: catalog.payload.pricing_version,
        priceSnapshot: {
          catalogVersion: catalog.payload.pricing_version,
          fetchedAt: catalog.fetchedAt.toISOString(),
          stale: catalog.stale,
          item,
          ...(input.auditMetadata ? { audit: input.auditMetadata } : {}),
        } as Prisma.InputJsonObject,
        occurredAt: now,
        settledAt: now,
      },
      update: {
        userId: input.userId,
        taskType: input.taskType,
        sourceType: input.sourceType,
        sourceTaskId: input.sourceTaskId,
        model: item.model_name,
        quantity,
        unit: item.request_unit!,
        unitPrice,
        amount,
        status: BillingStatus.settled,
        pricingVersion: catalog.payload.pricing_version,
        priceSnapshot: {
          catalogVersion: catalog.payload.pricing_version,
          fetchedAt: catalog.fetchedAt.toISOString(),
          stale: catalog.stale,
          item,
          ...(input.auditMetadata ? { audit: input.auditMetadata } : {}),
        } as Prisma.InputJsonObject,
        billingError: null,
        occurredAt: now,
        settledAt: now,
        voidedAt: null,
      },
    })
  } catch (error) {
    const now = input.occurredAt || new Date()
    const quantity = decimal(input.durationSeconds ?? input.quantity ?? 1)
    const pendingSnapshot = {
      ...(input.durationSeconds == null ? {} : { durationSeconds: decimal(input.durationSeconds).toString() }),
      ...(input.auditMetadata ? { audit: input.auditMetadata } : {}),
    } as Prisma.InputJsonObject
    await prisma.usageLedger.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        taskType: input.taskType,
        sourceType: input.sourceType,
        sourceTaskId: input.sourceTaskId,
        model: input.model,
        quantity,
        unit: input.taskType === BillingTaskType.image
          ? 'image'
          : input.durationSeconds == null ? 'generation' : 'second',
        status: BillingStatus.pending,
        priceSnapshot: pendingSnapshot,
        billingError: errorMessage(error),
        occurredAt: now,
      },
      update: {
        model: input.model,
        quantity,
        status: BillingStatus.pending,
        priceSnapshot: pendingSnapshot,
        billingError: errorMessage(error),
        occurredAt: now,
      },
    }).catch((ledgerError) => {
      console.error('BILLING_LEDGER_WRITE_FAILED', errorMessage(ledgerError))
    })
    console.error('BILLING_PRICE_RESOLUTION_FAILED', errorMessage(error))
    return null
  }
}

export async function voidPendingUsage(sourceType: string, sourceTaskId: string, reason: string) {
  return prisma.usageLedger.updateMany({
    where: { sourceType, sourceTaskId, status: BillingStatus.pending },
    data: {
      status: BillingStatus.void,
      billingError: reason.slice(0, 2000),
      voidedAt: new Date(),
    },
  })
}

export async function reconcilePendingUsage(limit = 200) {
  const pending = await prisma.usageLedger.findMany({
    where: { status: BillingStatus.pending },
    orderBy: { occurredAt: 'asc' },
    take: Math.max(1, Math.min(500, limit)),
  })
  let settled = 0
  for (const entry of pending) {
    const snapshot = entry.priceSnapshot && typeof entry.priceSnapshot === 'object' && !Array.isArray(entry.priceSnapshot)
      ? entry.priceSnapshot as Record<string, unknown>
      : {}
    const usage = snapshot.usage && typeof snapshot.usage === 'object' && !Array.isArray(snapshot.usage)
      ? snapshot.usage as Record<string, unknown>
      : null
    const durationSeconds = typeof snapshot.durationSeconds === 'string' || typeof snapshot.durationSeconds === 'number'
      ? snapshot.durationSeconds
      : undefined
    const result = entry.taskType === BillingTaskType.text && usage
      ? await recordCompletedTextUsage({
          idempotencyKey: entry.idempotencyKey,
          userId: entry.userId,
          sourceTaskId: entry.sourceTaskId,
          model: entry.model,
          usage: {
            inputTokens: Number(usage.inputTokens || 0),
            outputTokens: Number(usage.outputTokens || 0),
            cachedInputTokens: Number(usage.cachedInputTokens || 0),
          },
          occurredAt: entry.occurredAt,
        })
      : await recordCompletedUsage({
          idempotencyKey: entry.idempotencyKey,
          userId: entry.userId,
          taskType: entry.taskType,
          sourceType: entry.sourceType,
          sourceTaskId: entry.sourceTaskId,
          model: entry.model,
          quantity: entry.quantity,
          durationSeconds,
          occurredAt: entry.occurredAt,
        })
    if (result?.status === BillingStatus.settled) settled++
  }
  return { checked: pending.length, settled }
}

export function resetBillingCachesForTests() {
  catalogCache = null
}
