import { prisma } from '../lib/db'
import { auditScriptEpisodes, scriptAuditPassed } from '../lib/script-quality'

const projectId = process.argv[2]
const episodeMinutes = Number(process.argv[3] || 1.5)

if (!projectId) {
  throw new Error('Usage: npx tsx src/scripts/audit-script-quality.ts <projectId> [episodeMinutes]')
}

const episodes = await prisma.scriptEpisode.findMany({
  where: { projectId },
  orderBy: { episodeNumber: 'asc' },
  select: {
    episodeNumber: true,
    title: true,
    content: true,
    sourceChunkIndexes: true,
  },
})

const audit = auditScriptEpisodes(episodes, episodeMinutes)
console.log(JSON.stringify({
  projectId,
  episodeCount: episodes.length,
  passed: scriptAuditPassed(audit),
  ...audit,
}, null, 2))

await prisma.$disconnect()
