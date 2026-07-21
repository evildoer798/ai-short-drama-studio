import { readFile } from 'node:fs/promises'
import { prisma } from '../src/lib/db'
import { syncStoryboardAssetLinks } from '../src/lib/storyboards'
import { buildStoryboardStorageKey, uploadBuffer } from '../src/lib/storage'

type Metadata = {
  taskId: string
  model: string
  duration: number
  references: Array<{
    assetId: string
    mediaId: string
    name: string
  }>
}

const metadata = JSON.parse(
  await readFile(new URL('../artifacts/storyboard-assets-15s.json', import.meta.url), 'utf8'),
) as Metadata

const existingVideo = await prisma.storyboardVideo.findFirst({
  where: { providerJobId: metadata.taskId },
})
if (existingVideo) {
  console.log(`Existing storyboard video already imported: ${existingVideo.id}`)
  await prisma.$disconnect()
  process.exit(0)
}

const referenceAsset = await prisma.asset.findUnique({
  where: { id: metadata.references[0]?.assetId },
  select: { projectId: true },
})
if (!referenceAsset) throw new Error('Reference asset for the existing video was not found')

const videoPrompt = await readFile(
  new URL('./storyboard-asset-video-prompt.txt', import.meta.url),
  'utf8',
)
let storyboard = await prisma.storyboard.findFirst({
  where: {
    projectId: referenceAsset.projectId,
    title: '母女视频通话',
  },
})
if (!storyboard) {
  const aggregate = await prisma.storyboard.aggregate({
    where: { projectId: referenceAsset.projectId },
    _max: { sceneNumber: true },
  })
  storyboard = await prisma.storyboard.create({
    data: {
      projectId: referenceAsset.projectId,
      title: '母女视频通话',
      sceneNumber: (aggregate._max.sceneNumber || 0) + 1,
      notes: '使用苏文菁与陈蕊资产主图生成的 Seedance 15 秒样片。',
      videoPrompt,
      duration: metadata.duration,
      aspectRatio: '16:9',
      generateAudio: true,
    },
  })
}
await syncStoryboardAssetLinks(storyboard.id)

const bytes = await readFile(new URL('../artifacts/storyboard-assets-15s.mp4', import.meta.url))
const mimeType = 'video/mp4'
const storageKey = buildStoryboardStorageKey({
  projectId: referenceAsset.projectId,
  storyboardId: storyboard.id,
  mimeType,
})
await uploadBuffer({ key: storageKey, body: bytes, mimeType })

const video = await prisma.$transaction(async (tx) => {
  const media = await tx.mediaObject.create({
    data: {
      kind: 'video',
      storageKey,
      mimeType,
      sizeBytes: BigInt(bytes.byteLength),
      width: 1280,
      height: 720,
    },
  })
  const created = await tx.storyboardVideo.create({
    data: {
      storyboardId: storyboard.id,
      mediaId: media.id,
      prompt: videoPrompt,
      model: metadata.model,
      providerJobId: metadata.taskId,
      duration: metadata.duration,
      aspectRatio: '16:9',
      isSelected: true,
    },
  })
  await tx.storyboardVideo.updateMany({
    where: { storyboardId: storyboard.id, id: { not: created.id } },
    data: { isSelected: false },
  })
  await tx.storyboard.update({
    where: { id: storyboard.id },
    data: { selectedVideoId: created.id },
  })
  return created
})

console.log(`Imported storyboard video: ${video.id}`)
await prisma.$disconnect()
