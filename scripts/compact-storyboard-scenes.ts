import { prisma } from '@/lib/db'
import { compactLegacyStoryboardSceneSection } from '@/lib/storyboard-scene'

const apply = process.argv.includes('--apply')

function compactSceneInPrompt(
  videoPrompt: string,
  fallbackSceneName: string,
  fallbackEnvironment = '',
) {
  const sceneHeading = /^【场景】\s*$/mu.exec(videoPrompt)
  const timelineHeading = /^【视频分镜】\s*$/mu.exec(videoPrompt)
  if (!sceneHeading || !timelineHeading || timelineHeading.index <= sceneHeading.index) return videoPrompt
  const sceneStart = sceneHeading.index + sceneHeading[0].length
  const compactScene = compactLegacyStoryboardSceneSection(
    videoPrompt.slice(sceneStart, timelineHeading.index).trim(),
    fallbackSceneName,
    fallbackEnvironment,
  )
  return `${videoPrompt.slice(0, sceneStart)}\n${compactScene}\n${videoPrompt.slice(timelineHeading.index)}`
}

async function main() {
  const storyboards = await prisma.storyboard.findMany({
    where: { videoPrompt: { contains: '【场景】' } },
    select: { id: true, projectId: true, notes: true, videoPrompt: true },
  })
  const assets = await prisma.asset.findMany({
    where: {
      type: 'location',
      projectId: { in: [...new Set(storyboards.map((storyboard) => storyboard.projectId))] },
    },
    select: { projectId: true, name: true, description: true, prompt: true },
  })
  const assetDescriptions = new Map(assets.map((asset) => (
    [`${asset.projectId}\u0000${asset.name}`, `${asset.description}\n${asset.prompt || ''}`] as const
  )))
  let changed = 0
  for (const storyboard of storyboards) {
    const currentPrompt = storyboard.videoPrompt || ''
    const sceneName = (storyboard.notes || '').split('\n', 1)[0].split('｜').at(-1)?.trim() || ''
    const nextPrompt = compactSceneInPrompt(
      currentPrompt,
      sceneName,
      assetDescriptions.get(`${storyboard.projectId}\u0000${sceneName}`) || '',
    )
    if (nextPrompt === currentPrompt) continue
    changed++
    if (apply) {
      await prisma.storyboard.update({
        where: { id: storyboard.id },
        data: { videoPrompt: nextPrompt },
      })
    }
  }
  console.log(JSON.stringify({ scanned: storyboards.length, changed, applied: apply }))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(async () => prisma.$disconnect())
