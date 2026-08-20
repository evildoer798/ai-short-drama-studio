import { GenerationTaskType } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { createTextTask } from '../src/lib/preproduction'
import { getTextQueue } from '../src/lib/queue'

const projectId = process.argv[2]?.trim()
const episodeNumber = Number(process.argv[3])
if (!projectId || !Number.isInteger(episodeNumber) || episodeNumber <= 0) {
  throw new Error('Usage: tsx scripts/regenerate-assets-for-episode.ts <project-id> <episode-number>')
}

const [episode, member] = await Promise.all([
  prisma.scriptEpisode.findUnique({
    where: { projectId_episodeNumber: { projectId, episodeNumber } },
    select: { id: true, title: true, locked: true, _count: { select: { storyboards: true } } },
  }),
  prisma.projectMember.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  }),
])
if (!episode) throw new Error(`Episode ${episodeNumber} was not found in project ${projectId}`)
if (!episode.locked) throw new Error(`Episode ${episodeNumber} is not locked`)
if (episode._count.storyboards === 0) throw new Error(`Episode ${episodeNumber} has no storyboards`)
if (!member) throw new Error(`Project ${projectId} has no member to own the task`)

const task = await createTextTask({
  type: GenerationTaskType.asset_extraction,
  projectId,
  createdById: member.userId,
  prompt: `按第 ${episodeNumber} 集《${episode.title}》已完成分镜重新规划角色、标准场景和核心道具资产`,
  payload: { episodeIds: [episode.id] },
})

console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  projectId,
  episodeNumber,
  status: task.status,
}, null, 2))

await getTextQueue().close()
await prisma.$disconnect()
