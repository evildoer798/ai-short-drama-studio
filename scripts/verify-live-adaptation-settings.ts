import { createHmac } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const projectId = process.argv[2]?.trim()
const expectedEpisodes = Number(process.argv[3])
const expectedMinutes = Number(process.argv[4])
const baseUrl = process.env.VERIFY_BASE_URL || 'http://127.0.0.1:14000'
const authSecret = process.env.AUTH_SECRET

if (!projectId || !Number.isFinite(expectedEpisodes) || !Number.isFinite(expectedMinutes)) {
  throw new Error('Usage: tsx verify-live-adaptation-settings.ts <project-id> <episodes> <minutes>')
}
if (!authSecret) throw new Error('AUTH_SECRET is required')

try {
  const user = await prisma.user.findUnique({ where: { email: '2992656728@qq.com' } })
  if (!user) throw new Error('Verification user not found')
  const body = Buffer.from(JSON.stringify({
    userId: user.id,
    exp: Date.now() + 5 * 60 * 1000,
  })).toString('base64url')
  const signature = createHmac('sha256', authSecret).update(body).digest('base64url')
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/preproduction`, {
    headers: { Cookie: `shortdrama_session=${body}.${signature}` },
  })
  const payload = await response.json() as {
    adaptationSettings?: {
      targetEpisodeCount?: number
      episodeMinutes?: number
      source?: string
    }
    episodes?: unknown[]
    tasks?: Array<{ type: string; status: string; progress: number; model: string }>
  }
  if (!response.ok) throw new Error(`Preproduction API returned ${response.status}`)
  if (
    payload.adaptationSettings?.targetEpisodeCount !== expectedEpisodes
    || payload.adaptationSettings?.episodeMinutes !== expectedMinutes
    || payload.adaptationSettings?.source !== 'task'
    || payload.episodes?.length !== expectedEpisodes
  ) {
    throw new Error(`Unexpected adaptation result: settings=${JSON.stringify(payload.adaptationSettings)} episodes=${payload.episodes?.length}`)
  }
  console.log(JSON.stringify({
    ok: true,
    adaptationSettings: payload.adaptationSettings,
    episodeCount: payload.episodes.length,
    latestTask: payload.tasks?.find((task) => task.type === 'script_adaptation') || null,
  }, null, 2))
} finally {
  await prisma.$disconnect()
}
