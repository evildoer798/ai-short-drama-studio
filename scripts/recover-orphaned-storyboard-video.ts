import { prisma } from '@/lib/db'
import { getVideoQueue } from '@/lib/queue'

function stringArray(value: string | undefined) {
  return [...new Set((value || '').split(',').map((item) => item.trim()).filter(Boolean))]
}

async function main() {
  const [jobId, storyboardId, sourceIdsValue] = process.argv.slice(2)
  if (!jobId || !storyboardId) {
    throw new Error('Usage: recover-orphaned-storyboard-video <queue-job-id> <storyboard-id> [source-storyboard-ids]')
  }

  const queue = getVideoQueue()
  const job = await queue.getJob(jobId)
  if (!job) throw new Error(`Video queue job not found: ${jobId}`)
  const result = job.returnvalue && typeof job.returnvalue === 'object'
    ? job.returnvalue as Record<string, unknown>
    : null
  if (!result) throw new Error(`Video queue job has no recovery result: ${jobId}`)

  const videoId = String(result.id || '').trim()
  const mediaId = String(result.mediaId || '').trim()
  const prompt = String(result.prompt || '').trim()
  const model = String(result.model || '').trim()
  const providerJobId = String(result.providerJobId || '').trim() || null
  const duration = Math.round(Number(result.duration))
  const aspectRatio = String(result.aspectRatio || '16:9').trim()
  if (!videoId || !mediaId || !prompt || !model || !Number.isFinite(duration)) {
    throw new Error(`Video queue result is incomplete: ${jobId}`)
  }

  const [storyboard, media, existing] = await Promise.all([
    prisma.storyboard.findUnique({
      where: { id: storyboardId },
      select: { id: true, projectId: true, selectedVideoId: true },
    }),
    prisma.mediaObject.findUnique({ where: { id: mediaId } }),
    prisma.storyboardVideo.findUnique({ where: { id: videoId } }),
  ])
  if (!storyboard) throw new Error(`Recovery storyboard not found: ${storyboardId}`)
  if (!media) throw new Error(`Recovery media not found: ${mediaId}`)
  if (!media.storageKey.startsWith(`projects/${storyboard.projectId}/`)) {
    throw new Error('Recovery media belongs to another project')
  }
  if (existing) {
    console.log(`VIDEO_ALREADY_LINKED id=${existing.id}`)
    await queue.close()
    return
  }

  const requestedSourceIds = stringArray(sourceIdsValue)
  const validSources = requestedSourceIds.length > 0
    ? await prisma.storyboard.findMany({
        where: { id: { in: requestedSourceIds }, projectId: storyboard.projectId },
        select: { id: true },
      })
    : []
  const sourceStoryboardIds = validSources.length > 0
    ? requestedSourceIds.filter((id) => validSources.some((source) => source.id === id))
    : [storyboard.id]
  const selectRecoveredVideo = !storyboard.selectedVideoId && result.isSelected !== false

  await prisma.$transaction(async (tx) => {
    await tx.storyboardVideo.create({
      data: {
        id: videoId,
        storyboardId: storyboard.id,
        sourceStoryboardIds,
        mediaId,
        name: typeof result.name === 'string' && result.name.trim() ? result.name.trim() : null,
        prompt,
        model,
        providerJobId,
        duration,
        aspectRatio,
        isSelected: selectRecoveredVideo,
        createdAt: result.createdAt ? new Date(String(result.createdAt)) : media.createdAt,
      },
    })
    if (selectRecoveredVideo) {
      await tx.storyboard.update({
        where: { id: storyboard.id },
        data: { selectedVideoId: videoId },
      })
    }
  })

  console.log(`VIDEO_RECOVERED id=${videoId} media=${mediaId} storyboard=${storyboard.id}`)
  await queue.close()
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
