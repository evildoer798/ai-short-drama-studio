import { GenerationTaskType, Prisma, TaskStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getTextQueue, requeueTextGenerationTask } from '@/lib/queue'

const taskId = process.argv[2]?.trim()
if (!taskId) throw new Error('Usage: tsx requeue-failed-text-task.ts <task-id>')

const textTypes = new Set<GenerationTaskType>([
  GenerationTaskType.script_adaptation,
  GenerationTaskType.script_revision,
  GenerationTaskType.asset_extraction,
  GenerationTaskType.storyboard_generation,
])

const task = await prisma.generationTask.findUnique({ where: { id: taskId } })
if (!task) throw new Error(`Task not found: ${taskId}`)
if (!textTypes.has(task.type)) throw new Error(`Task is not a text task: ${task.type}`)
if (task.status !== TaskStatus.failed) {
  throw new Error(`Task must be failed before requeueing: ${task.status}`)
}

const payload = task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload)
  ? { ...(task.payload as Record<string, unknown>) }
  : {}
delete payload.textAutoRecovery

await prisma.generationTask.update({
  where: { id: task.id },
  data: {
    status: TaskStatus.queued,
    model: env.textModel(),
    error: null,
    completedAt: null,
    startedAt: null,
    payload: payload as Prisma.InputJsonObject,
  },
})

try {
  await requeueTextGenerationTask(task.id)
} catch (error) {
  await prisma.generationTask.update({
    where: { id: task.id },
    data: {
      status: TaskStatus.failed,
      error: task.error,
      completedAt: new Date(),
      payload: task.payload ?? Prisma.JsonNull,
    },
  })
  throw error
}

console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  projectId: task.projectId,
  status: TaskStatus.queued,
  model: env.textModel(),
}, null, 2))

await getTextQueue().close()
await prisma.$disconnect()
