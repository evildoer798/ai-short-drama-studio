import { GenerationTaskType } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { createTextTask } from '../src/lib/preproduction'
import { getTextQueue } from '../src/lib/queue'

const projectId = process.argv[2]?.trim()
const episodeNumber = Number(process.argv[3])
if (!projectId || !Number.isInteger(episodeNumber) || episodeNumber <= 0) {
  throw new Error('Usage: tsx scripts/regenerate-storyboard-episode.ts <project-id> <episode-number>')
}

const [episode, member] = await Promise.all([
  prisma.scriptEpisode.findUnique({
    where: { projectId_episodeNumber: { projectId, episodeNumber } },
    select: { id: true, title: true, locked: true },
  }),
  prisma.projectMember.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  }),
])
if (!episode) throw new Error(`Episode ${episodeNumber} was not found in project ${projectId}`)
if (!episode.locked) throw new Error(`Episode ${episodeNumber} is not locked`)
if (!member) throw new Error(`Project ${projectId} has no member to own the task`)

const task = await createTextTask({
  type: GenerationTaskType.storyboard_generation,
  projectId,
  createdById: member.userId,
  prompt: `重新生成第 ${episodeNumber} 集《${episode.title}》的电影级视频分镜`,
  payload: {
    episodeIds: [episode.id],
    replaceExisting: true,
  },
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
