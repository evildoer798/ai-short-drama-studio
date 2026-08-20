import { TaskStatus } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { getVideoQueue } from '../src/lib/queue'

const taskId = process.argv[2]?.trim()
if (!taskId) throw new Error('Usage: cancel-video-task <task-id>')
const reason = process.argv.slice(3).join(' ').trim()
  || '用户取消了该视频生成任务。'

const queue = getVideoQueue()

try {
  const job = await queue.getJob(taskId)
  if (job) {
    const state = await job.getState()
    if (state === 'active') throw new Error('VIDEO_TASK_ACTIVE: wait for the current provider request to finish')
    await job.remove()
  }

  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.failed,
      progress: 0,
      completedAt: new Date(),
      error: `VIDEO_TASK_CANCELLED: ${reason}`,
    },
  })

  console.log(`Cancelled video task ${taskId}`)
} finally {
  await queue.close()
  await prisma.$disconnect()
}
