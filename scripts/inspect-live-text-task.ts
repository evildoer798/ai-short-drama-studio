import { prisma } from '@/lib/db'
import { getTextQueue } from '@/lib/queue'

const taskId = process.argv[2]?.trim()
if (!taskId) throw new Error('Usage: tsx inspect-live-text-task.ts <task-id>')

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const task = await prisma.generationTask.findUnique({
  where: { id: taskId },
  select: {
    id: true,
    projectId: true,
    type: true,
    status: true,
    progress: true,
    error: true,
    updatedAt: true,
    startedAt: true,
    completedAt: true,
    payload: true,
  },
})
if (!task) throw new Error(`Task not found: ${taskId}`)

const job = await getTextQueue().getJob(taskId)
const payload = record(task.payload)
const checkpoint = record(payload.adaptationCheckpoint)
const recovery = record(payload.textAutoRecovery)

console.log(JSON.stringify({
  task: {
    id: task.id,
    projectId: task.projectId,
    type: task.type,
    status: task.status,
    progress: task.progress,
    error: task.error,
    updatedAt: task.updatedAt.toISOString(),
    startedAt: task.startedAt?.toISOString() || null,
    completedAt: task.completedAt?.toISOString() || null,
  },
  queue: job ? {
    state: await job.getState(),
    attemptsMade: job.attemptsMade,
    maxAttempts: Number(job.opts.attempts || 1),
    failedReason: job.failedReason || null,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
  } : null,
  checkpoint: {
    analyses: Array.isArray(checkpoint.analyses) ? checkpoint.analyses.length : 0,
    seriesBibleParts: Array.isArray(checkpoint.seriesBibleParts) ? checkpoint.seriesBibleParts.length : 0,
    hasSeriesBible: Boolean(checkpoint.seriesBible),
    planEpisodes: Array.isArray(checkpoint.plan) ? checkpoint.plan.length : 0,
    drafts: Array.isArray(checkpoint.drafts) ? checkpoint.drafts.length : 0,
    nameMappings: Array.isArray(checkpoint.nameMappings) ? checkpoint.nameMappings.length : 0,
    nameAuditCompleted: checkpoint.nameAuditCompleted === true,
    autoRecoveryAttempts: typeof recovery.attempts === 'number' ? recovery.attempts : 0,
  },
}, null, 2))

await getTextQueue().close()
await prisma.$disconnect()
