import { GenerationTaskType, ProjectRole } from '@prisma/client'
import { prisma } from '../lib/db'
import { createTextTask } from '../lib/preproduction'
import { getTextQueue } from '../lib/queue'

const projectId = process.argv[2]
const targetEpisodeCount = Number(process.argv[3] || 36)
const episodeMinutes = Number(process.argv[4] || 1.5)

if (!projectId) {
  throw new Error('Usage: npx tsx src/scripts/queue-script-readaptation.ts <projectId> [episodeCount] [episodeMinutes]')
}
if (!Number.isInteger(targetEpisodeCount) || targetEpisodeCount < 1 || targetEpisodeCount > 60) {
  throw new Error('episodeCount must be an integer from 1 to 60')
}
if (!Number.isFinite(episodeMinutes) || episodeMinutes < 0.5 || episodeMinutes > 10) {
  throw new Error('episodeMinutes must be from 0.5 to 10')
}

const member = await prisma.projectMember.findFirst({
  where: { projectId },
  orderBy: { createdAt: 'asc' },
  select: { userId: true, role: true },
})
if (!member) throw new Error('Project has no member who can own the repair task')

const owner = member.role === ProjectRole.owner
  ? member
  : await prisma.projectMember.findFirst({
      where: { projectId, role: ProjectRole.owner },
      select: { userId: true, role: true },
    }) || member

const task = await createTextTask({
  type: GenerationTaskType.script_adaptation,
  projectId,
  createdById: owner.userId,
  prompt: `重新改编并终检为 ${targetEpisodeCount} 集短剧`,
  payload: {
    targetEpisodeCount,
    episodeMinutes,
    replaceExisting: true,
  },
})

console.log(JSON.stringify({
  taskId: task.id,
  status: task.status,
  targetEpisodeCount,
  episodeMinutes,
}, null, 2))

await getTextQueue().close()
await prisma.$disconnect()
