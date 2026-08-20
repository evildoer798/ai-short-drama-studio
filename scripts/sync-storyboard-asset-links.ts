import { prisma } from '../src/lib/db'
import { syncStoryboardAssetLinks } from '../src/lib/storyboards'

const projectId = process.argv[2]?.trim()
if (!projectId) {
  throw new Error('Usage: tsx scripts/sync-storyboard-asset-links.ts <project-id>')
}

const storyboards = await prisma.storyboard.findMany({
  where: { projectId },
  orderBy: { sceneNumber: 'asc' },
  select: { id: true },
})

let synced = 0
for (let index = 0; index < storyboards.length; index += 8) {
  const batch = storyboards.slice(index, index + 8)
  await Promise.all(batch.map((storyboard) => syncStoryboardAssetLinks(storyboard.id)))
  synced += batch.length
}

console.log(JSON.stringify({ ok: true, projectId, synced }, null, 2))
await prisma.$disconnect()
