import { prisma } from '@/lib/db'
import { naturalizeStoryboardTimeline } from '@/lib/storyboard-timeline'

const apply = process.argv.includes('--apply')
const showTimelines = process.argv.includes('--show-timelines')

function argumentValue(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() || '' : ''
}

function replaceTimeline(videoPrompt: string) {
  const heading = /^【视频分镜】\s*$/mu.exec(videoPrompt)
  if (!heading) return videoPrompt
  const timelineStart = heading.index + heading[0].length
  const currentTimeline = videoPrompt.slice(timelineStart).trim()
  const naturalTimeline = naturalizeStoryboardTimeline(currentTimeline, {
    maximumCharactersPerSegment: 150,
  })
  if (!naturalTimeline) return videoPrompt
  return `${videoPrompt.slice(0, timelineStart)}\n${naturalTimeline}`
}

function timelineFromPrompt(videoPrompt: string) {
  return videoPrompt.split('【视频分镜】', 2)[1]?.trim() || ''
}

async function main() {
  const projectId = argumentValue('--project-id')
  const episodeNumber = Number(argumentValue('--episode'))
  if (!projectId || !Number.isInteger(episodeNumber) || episodeNumber <= 0) {
    throw new Error('请提供 --project-id <项目ID> --episode <集数>，确认预览后再加 --apply')
  }

  const episode = await prisma.scriptEpisode.findUnique({
    where: { projectId_episodeNumber: { projectId, episodeNumber } },
    select: { id: true, title: true },
  })
  if (!episode) throw new Error(`未找到项目 ${projectId} 的第 ${episodeNumber} 集`)

  const storyboards = await prisma.storyboard.findMany({
    where: { projectId, episodeId: episode.id },
    orderBy: [{ episodeSceneNumber: 'asc' }, { sceneNumber: 'asc' }],
    select: {
      id: true,
      episodeSceneNumber: true,
      title: true,
      videoPrompt: true,
      selectedVideoId: true,
      _count: { select: { videos: true } },
    },
  })

  const changes = storyboards.flatMap((storyboard) => {
    const currentPrompt = storyboard.videoPrompt || ''
    const nextPrompt = replaceTimeline(currentPrompt)
    return nextPrompt && nextPrompt !== currentPrompt
      ? [{ storyboard, currentPrompt, nextPrompt }]
      : []
  })

  if (apply && changes.length > 0) {
    await prisma.$transaction(changes.map(({ storyboard, nextPrompt }) => (
      prisma.storyboard.update({
        where: { id: storyboard.id },
        data: { videoPrompt: nextPrompt },
      })
    )))
  }

  console.log(JSON.stringify({
    projectId,
    episodeNumber,
    episodeTitle: episode.title,
    scanned: storyboards.length,
    changed: changes.length,
    applied: apply,
    preservedVideos: storyboards.reduce((total, storyboard) => total + storyboard._count.videos, 0),
    selectedVideos: storyboards.filter((storyboard) => storyboard.selectedVideoId).length,
    storyboards: changes.map(({ storyboard, currentPrompt, nextPrompt }) => ({
      number: storyboard.episodeSceneNumber,
      title: storyboard.title,
      before: currentPrompt.length,
      after: nextPrompt.length,
      videos: storyboard._count.videos,
      ...(showTimelines ? { timeline: timelineFromPrompt(nextPrompt) } : {}),
    })),
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(async () => prisma.$disconnect())
