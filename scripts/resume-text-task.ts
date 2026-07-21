import { prisma } from '../src/lib/db'
import { processTextGenerationTask } from '../src/lib/worker/text-generation'

const taskId = process.argv[2]?.trim()
if (!taskId) {
  throw new Error('Usage: npm run resume:text-task -- <task-id>')
}

const task = await prisma.generationTask.findUnique({
  where: { id: taskId },
  select: { id: true, type: true, status: true, projectId: true },
})
if (!task) throw new Error(`Text task not found: ${taskId}`)

const episodeArg = process.argv.indexOf('--episodes')
const minutesArg = process.argv.indexOf('--minutes')
const targetEpisodeCount = episodeArg >= 0 ? Number(process.argv[episodeArg + 1]) : null
const episodeMinutes = minutesArg >= 0 ? Number(process.argv[minutesArg + 1]) : null
if (targetEpisodeCount != null || episodeMinutes != null) {
  const current = await prisma.generationTask.findUnique({ where: { id: task.id }, select: { payload: true } })
  const payload = current?.payload && typeof current.payload === 'object' && !Array.isArray(current.payload)
    ? current.payload
    : {}
  await prisma.generationTask.update({
    where: { id: task.id },
    data: {
      payload: {
        ...payload,
        ...(targetEpisodeCount != null ? { targetEpisodeCount } : {}),
        ...(episodeMinutes != null ? { episodeMinutes } : {}),
      },
    },
  })
}

console.log(`Resuming ${task.type} task ${task.id} (${task.status})`)
const result = await processTextGenerationTask(task.id)
console.log(JSON.stringify({ taskId: task.id, projectId: task.projectId, result }, null, 2))
await prisma.$disconnect()
