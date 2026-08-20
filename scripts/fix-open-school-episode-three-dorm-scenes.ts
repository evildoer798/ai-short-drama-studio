import { AssetType } from '@prisma/client'
import { prisma } from '@/lib/db'
import { syncStoryboardAssetLinks } from '@/lib/storyboards'

const projectId = process.argv[2]?.trim()
const apply = process.argv.includes('--apply')
const targetNumbers = new Set([5, 6, 7, 8, 9])
const sceneSection = '【场景】\n日｜206宿舍内。大学宿舍内部，床铺、书桌、储物柜和自然窗光固定。'

if (!projectId) {
  throw new Error('Usage: tsx scripts/fix-open-school-episode-three-dorm-scenes.ts <project-id> [--apply]')
}

function replaceScene(videoPrompt: string) {
  const pattern = /^【场景】\s*$[\s\S]*?(?=^【视频分镜】\s*$)/mu
  if (!pattern.test(videoPrompt)) throw new Error('分镜缺少【场景】或【视频分镜】段落')
  return videoPrompt.replace(pattern, `${sceneSection}\n`)
}

const episode = await prisma.scriptEpisode.findUniqueOrThrow({
  where: { projectId_episodeNumber: { projectId, episodeNumber: 3 } },
  select: {
    title: true,
    content: true,
    storyboards: {
      where: { episodeSceneNumber: { in: [...targetNumbers] } },
      orderBy: { episodeSceneNumber: 'asc' },
      select: {
        id: true,
        episodeSceneNumber: true,
        notes: true,
        videoPrompt: true,
        selectedVideoId: true,
        _count: { select: { videos: true } },
      },
    },
  },
})

if (episode.title !== '家里不穷了'
  || episode.storyboards.length !== targetNumbers.size
  || !episode.content.includes('场次 2｜日/内/206宿舍内')) {
  throw new Error('第三集锁定剧本或目标分镜与预期不一致')
}

const changes = episode.storyboards.map((storyboard) => ({
  storyboard,
  nextPrompt: replaceScene(storyboard.videoPrompt || ''),
}))

if (apply) {
  await prisma.$transaction(changes.map(({ storyboard, nextPrompt }) => (
    prisma.storyboard.update({
      where: { id: storyboard.id },
      data: { notes: '日｜206宿舍内', videoPrompt: nextPrompt },
    })
  )))
  for (const { storyboard } of changes) await syncStoryboardAssetLinks(storyboard.id)
}

const refreshed = apply
  ? await prisma.storyboard.findMany({
      where: { id: { in: changes.map(({ storyboard }) => storyboard.id) } },
      orderBy: { episodeSceneNumber: 'asc' },
      select: {
        episodeSceneNumber: true,
        notes: true,
        assetLinks: {
          where: { asset: { type: AssetType.location } },
          select: { asset: { select: { name: true } } },
        },
      },
    })
  : []

console.log(JSON.stringify({
  applied: apply,
  changed: changes.filter(({ storyboard, nextPrompt }) => (
    storyboard.notes !== '日｜206宿舍内' || storyboard.videoPrompt !== nextPrompt
  )).length,
  preservedVideos: changes.reduce((total, { storyboard }) => total + storyboard._count.videos, 0),
  selectedVideos: changes.filter(({ storyboard }) => storyboard.selectedVideoId).length,
  storyboards: changes.map(({ storyboard }) => ({
    number: storyboard.episodeSceneNumber,
    beforeScene: storyboard.notes,
    afterScene: '日｜206宿舍内',
  })),
  refreshed,
}, null, 2))

await prisma.$disconnect()
