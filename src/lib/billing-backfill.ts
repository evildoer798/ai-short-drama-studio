import {
  BillingStatus,
  BillingTaskType,
  GenerationTaskType,
  Prisma,
  TaskStatus,
} from '@prisma/client'
import { recordCompletedUsage } from './billing'
import { prisma } from './db'

type HistoricalUsageCandidate = {
  idempotencyKey: string
  userId: string
  taskType: BillingTaskType
  sourceType: string
  sourceTaskId: string
  model: string
  occurredAt: Date
  durationSeconds?: number
}

type LegacyPrice = {
  billingMode: 'per_request' | 'per_second'
  unit: 'generation' | 'second'
  unitPrice: string
  basis: string
}

const LEGACY_MEDIA_PRICES: Record<string, LegacyPrice> = {
  'seedance-2.0-720p': {
    billingMode: 'per_second',
    unit: 'second',
    unitPrice: '0.975',
    basis: '历史应用模型目录：Seedance 2.0 720p，¥0.975/秒',
  },
  'seedance-2.0-mini-480p': {
    billingMode: 'per_second',
    unit: 'second',
    unitPrice: '0.30',
    basis: '历史应用模型目录：Seedance 2.0 Mini 480p，¥0.30/秒',
  },
  'seedance-2.0-mini-8s': {
    billingMode: 'per_second',
    unit: 'second',
    unitPrice: '0.30',
    basis: '历史固定 8 秒 Mini 路由，按同期 Mini 480p ¥0.30/秒复原',
  },
}

function record(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {}
}

function positiveInteger(value: unknown) {
  const parsed = Math.round(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function historicalVideoDuration(
  payload: Prisma.JsonValue | null,
  fallback: number | null | undefined,
) {
  return positiveInteger(record(payload).duration) || positiveInteger(fallback)
}

export function historicalLegacyPrice(model: string) {
  return LEGACY_MEDIA_PRICES[model.trim().toLocaleLowerCase()] || null
}

async function candidates() {
  const [generationTasks, canvasVideos, canvasImages, directorVideos, directorImages, directorStateImages] = await Promise.all([
    prisma.generationTask.findMany({
      where: {
        status: TaskStatus.completed,
        type: { in: [GenerationTaskType.image_generation, GenerationTaskType.video_generation] },
      },
      select: {
        id: true,
        type: true,
        createdById: true,
        model: true,
        requestedCount: true,
        payload: true,
        completedAt: true,
        updatedAt: true,
        storyboard: { select: { duration: true } },
      },
    }),
    prisma.canvasVideoTask.findMany({
      where: { status: TaskStatus.completed },
      select: { id: true, createdById: true, model: true, duration: true, completedAt: true, updatedAt: true },
    }),
    prisma.canvasImageTask.findMany({
      where: { status: TaskStatus.completed },
      select: { id: true, createdById: true, model: true, count: true, completedAt: true, updatedAt: true },
    }),
    prisma.directorVideoTask.findMany({
      where: { status: TaskStatus.completed },
      select: { id: true, createdById: true, model: true, duration: true, completedAt: true, updatedAt: true },
    }),
    prisma.directorImageTask.findMany({
      where: { status: TaskStatus.completed },
      select: { id: true, createdById: true, model: true, completedAt: true, updatedAt: true },
    }),
    prisma.directorStateImageTask.findMany({
      where: { status: TaskStatus.completed },
      select: { id: true, createdById: true, model: true, completedAt: true, updatedAt: true },
    }),
  ])

  const result: HistoricalUsageCandidate[] = []
  for (const task of generationTasks) {
    const occurredAt = task.completedAt || task.updatedAt
    if (task.type === GenerationTaskType.video_generation) {
      const durationSeconds = historicalVideoDuration(task.payload, task.storyboard?.duration)
      result.push({
        idempotencyKey: `generation-task:${task.id}:video`,
        userId: task.createdById,
        taskType: BillingTaskType.video,
        sourceType: 'generation_task',
        sourceTaskId: task.id,
        model: task.model,
        occurredAt,
        ...(durationSeconds ? { durationSeconds } : {}),
      })
      continue
    }
    for (let index = 0; index < Math.max(0, task.requestedCount); index++) {
      result.push({
        idempotencyKey: `generation-task:${task.id}:image:${index}`,
        userId: task.createdById,
        taskType: BillingTaskType.image,
        sourceType: 'generation_task',
        sourceTaskId: task.id,
        model: task.model,
        occurredAt,
      })
    }
  }
  for (const task of canvasVideos) {
    result.push({
      idempotencyKey: `canvas-video-task:${task.id}:video`,
      userId: task.createdById,
      taskType: BillingTaskType.video,
      sourceType: 'canvas_video_task',
      sourceTaskId: task.id,
      model: task.model,
      durationSeconds: task.duration,
      occurredAt: task.completedAt || task.updatedAt,
    })
  }
  for (const task of canvasImages) {
    for (let index = 0; index < Math.max(0, task.count); index++) {
      result.push({
        idempotencyKey: `canvas-image-task:${task.id}:image:${index}`,
        userId: task.createdById,
        taskType: BillingTaskType.image,
        sourceType: 'canvas_image_task',
        sourceTaskId: task.id,
        model: task.model,
        occurredAt: task.completedAt || task.updatedAt,
      })
    }
  }
  for (const task of directorVideos) {
    result.push({
      idempotencyKey: `director-video-task:${task.id}:video`,
      userId: task.createdById,
      taskType: BillingTaskType.video,
      sourceType: 'director_video_task',
      sourceTaskId: task.id,
      model: task.model,
      durationSeconds: task.duration,
      occurredAt: task.completedAt || task.updatedAt,
    })
  }
  for (const task of directorImages) {
    result.push({
      idempotencyKey: `director-image-task:${task.id}:image`,
      userId: task.createdById,
      taskType: BillingTaskType.image,
      sourceType: 'director_image_task',
      sourceTaskId: task.id,
      model: task.model,
      occurredAt: task.completedAt || task.updatedAt,
    })
  }
  for (const task of directorStateImages) {
    result.push({
      idempotencyKey: `director-state-image-task:${task.id}:image`,
      userId: task.createdById,
      taskType: BillingTaskType.image,
      sourceType: 'director_state_image_task',
      sourceTaskId: task.id,
      model: task.model,
      occurredAt: task.completedAt || task.updatedAt,
    })
  }
  return result
}

async function settleLegacyCandidate(candidate: HistoricalUsageCandidate, price: LegacyPrice) {
  const quantity = price.billingMode === 'per_second'
    ? new Prisma.Decimal(candidate.durationSeconds || 0)
    : new Prisma.Decimal(1)
  if (!quantity.isPositive()) return null
  const unitPrice = new Prisma.Decimal(price.unitPrice)
  const amount = quantity.mul(unitPrice)
  const settledAt = new Date()
  return prisma.usageLedger.upsert({
    where: { idempotencyKey: candidate.idempotencyKey },
    create: {
      idempotencyKey: candidate.idempotencyKey,
      userId: candidate.userId,
      taskType: candidate.taskType,
      sourceType: candidate.sourceType,
      sourceTaskId: candidate.sourceTaskId,
      model: candidate.model,
      quantity,
      unit: price.unit,
      unitPrice,
      amount,
      currency: 'CNY',
      status: BillingStatus.settled,
      pricingVersion: 'historical-app-catalog-v1',
      pricingSource: 'historical-app-price-reference',
      priceSnapshot: {
        historicalBackfill: true,
        billingMode: price.billingMode,
        basis: price.basis,
        originalModel: candidate.model,
        sourceCompletedAt: candidate.occurredAt.toISOString(),
      },
      occurredAt: candidate.occurredAt,
      settledAt,
    },
    update: {
      userId: candidate.userId,
      taskType: candidate.taskType,
      sourceType: candidate.sourceType,
      sourceTaskId: candidate.sourceTaskId,
      model: candidate.model,
      quantity,
      unit: price.unit,
      unitPrice,
      amount,
      currency: 'CNY',
      status: BillingStatus.settled,
      pricingVersion: 'historical-app-catalog-v1',
      pricingSource: 'historical-app-price-reference',
      priceSnapshot: {
        historicalBackfill: true,
        billingMode: price.billingMode,
        basis: price.basis,
        originalModel: candidate.model,
        sourceCompletedAt: candidate.occurredAt.toISOString(),
      },
      billingError: null,
      occurredAt: candidate.occurredAt,
      settledAt,
      voidedAt: null,
    },
  })
}

export async function backfillHistoricalMediaUsage(options: { dryRun?: boolean } = {}) {
  const allCandidates = await candidates()
  const existing = await prisma.usageLedger.findMany({
    where: { idempotencyKey: { in: allCandidates.map((candidate) => candidate.idempotencyKey) } },
    select: { idempotencyKey: true, status: true },
  })
  const settledKeys = new Set(existing
    .filter((entry) => entry.status === BillingStatus.settled)
    .map((entry) => entry.idempotencyKey))
  const pendingCandidates = allCandidates.filter((candidate) => !settledKeys.has(candidate.idempotencyKey))
  const byType = Object.fromEntries(Object.values(BillingTaskType).map((type) => [
    type,
    pendingCandidates.filter((candidate) => candidate.taskType === type).length,
  ]))
  if (options.dryRun !== false) {
    return {
      dryRun: true,
      discovered: allCandidates.length,
      alreadySettled: settledKeys.size,
      missing: pendingCandidates.length,
      byType,
      settled: 0,
      unresolved: 0,
    }
  }

  let settled = 0
  let unresolved = 0
  for (const candidate of pendingCandidates) {
    const ledger = await recordCompletedUsage({
      ...candidate,
      auditMetadata: {
        historicalBackfill: true,
        sourceCompletedAt: candidate.occurredAt.toISOString(),
      },
    })
    if (ledger?.status === BillingStatus.settled) {
      settled++
      continue
    }
    const legacyPrice = historicalLegacyPrice(candidate.model)
    const legacyLedger = legacyPrice
      ? await settleLegacyCandidate(candidate, legacyPrice)
      : null
    if (legacyLedger?.status === BillingStatus.settled) settled++
    else unresolved++
  }
  return {
    dryRun: false,
    discovered: allCandidates.length,
    alreadySettled: settledKeys.size,
    missing: pendingCandidates.length,
    byType,
    settled,
    unresolved,
  }
}
