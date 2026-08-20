import { AssetType } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { extractScriptSceneLocations } from '../src/lib/preproduction-prompts'
import { splitStoryboardScript } from '../src/lib/worker/text-generation'

const projectId = process.argv[2]?.trim()
const episodeNumber = Number(process.argv[3])
if (!projectId || !Number.isInteger(episodeNumber) || episodeNumber <= 0) {
  throw new Error('Usage: tsx scripts/inspect-episode-storyboards.ts <project-id> <episode-number>')
}

const episode = await prisma.scriptEpisode.findUniqueOrThrow({
  where: { projectId_episodeNumber: { projectId, episodeNumber } },
  select: {
    id: true,
    title: true,
    content: true,
    storyboards: {
      orderBy: { episodeSceneNumber: 'asc' },
      select: {
        id: true,
        episodeSceneNumber: true,
        title: true,
        notes: true,
        duration: true,
        videoPrompt: true,
        assetLinks: {
          where: { asset: { type: AssetType.location } },
          orderBy: { referenceOrder: 'asc' },
          select: { asset: { select: { name: true } } },
        },
      },
    },
  },
})
const projectLocationAssets = await prisma.asset.findMany({
  where: { projectId, type: AssetType.location },
  orderBy: { createdAt: 'asc' },
  select: { id: true, name: true, description: true },
})

console.log(JSON.stringify({
  episodeNumber,
  title: episode.title,
  scriptScenes: extractScriptSceneLocations(episode.content),
  scriptContent: episode.content,
  scriptChunks: splitStoryboardScript(episode.content).map((chunk, index) => ({
    index: index + 1,
    firstLine: chunk.split('\n', 1)[0],
    scenes: extractScriptSceneLocations(chunk).map((scene) => scene.name),
    chars: chunk.length,
  })),
  projectLocationAssets,
  storyboardCount: episode.storyboards.length,
  totalSeconds: episode.storyboards.reduce((total, storyboard) => total + storyboard.duration, 0),
  storyboards: episode.storyboards.map((storyboard) => ({
    number: storyboard.episodeSceneNumber,
    title: storyboard.title,
    duration: storyboard.duration,
    scene: storyboard.notes,
    locationAssets: storyboard.assetLinks.map((link) => link.asset.name),
    blocksChineseSubtitles: storyboard.videoPrompt?.includes('不要出现中文字幕！') === true,
  })),
}, null, 2))

await prisma.$disconnect()
