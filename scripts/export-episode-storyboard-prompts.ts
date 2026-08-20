import { prisma } from '@/lib/db'

const projectId = process.argv[2]?.trim()
const episodeNumber = Number(process.argv[3])
const fromNumber = Number(process.argv[4] || 1)
const toNumber = Number(process.argv[5] || Number.MAX_SAFE_INTEGER)

if (!projectId || !Number.isInteger(episodeNumber) || episodeNumber <= 0) {
  throw new Error('Usage: tsx scripts/export-episode-storyboard-prompts.ts <project-id> <episode-number>')
}

const episode = await prisma.scriptEpisode.findUniqueOrThrow({
  where: { projectId_episodeNumber: { projectId, episodeNumber } },
  select: {
    title: true,
    storyboards: {
      orderBy: [{ episodeSceneNumber: 'asc' }, { sceneNumber: 'asc' }],
      select: {
        id: true,
        episodeSceneNumber: true,
        title: true,
        duration: true,
        videoPrompt: true,
        selectedVideoId: true,
        videos: { select: { id: true, model: true } },
      },
    },
  },
})

function extractVideoStoryboard(videoPrompt: string | null) {
  if (!videoPrompt) return ''
  const match = /^【视频分镜】\s*$([\s\S]*)/mu.exec(videoPrompt)
  return match?.[1]?.trim() || ''
}

console.log(JSON.stringify({
  title: episode.title,
  storyboards: episode.storyboards
    .filter((storyboard) => {
      const number = storyboard.episodeSceneNumber || 0
      return number >= fromNumber && number <= toNumber
    })
    .map((storyboard) => ({
      id: storyboard.id,
      number: storyboard.episodeSceneNumber,
      title: storyboard.title,
      duration: storyboard.duration,
      selectedVideoId: storyboard.selectedVideoId,
      videos: storyboard.videos,
      videoStoryboard: extractVideoStoryboard(storyboard.videoPrompt),
    })),
}, null, 2))

await prisma.$disconnect()
