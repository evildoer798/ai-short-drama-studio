import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../src/lib/db'
import { env } from '../src/lib/env'
import {
  detectVideoCapability,
  downloadOpenAIVideo,
  extractVideoUrl,
  retrieveVideoJob,
  submitVideoGeneration,
  type VideoApiConfig,
} from '../src/lib/openai-video'
import { buildStoryboardStorageKey, uploadBuffer } from '../src/lib/storage'

type ReferenceMetadata = {
  assetId: string
  mediaId: string
  name: string
}

const confirmedPaidRun = process.argv.includes('--confirm-paid')
if (!confirmedPaidRun) {
  throw new Error('PAID_GENERATION_CONFIRMATION_REQUIRED: rerun with -- --confirm-paid')
}

const outputDir = path.resolve('artifacts')
const keyframePath = path.join(outputDir, 'storyboard-assets-15s-preview.png')
const referenceMetadataPath = path.join(outputDir, 'storyboard-assets-15s.json')
const prompt = await readFile(new URL('./grok-real-video-prompt.txt', import.meta.url), 'utf8')
const referenceMetadata = JSON.parse(
  await readFile(referenceMetadataPath, 'utf8'),
) as { references: ReferenceMetadata[] }

if (referenceMetadata.references.length !== 2) {
  throw new Error('ASSET_REFERENCE_COUNT_INVALID: expected mother and daughter')
}

const selectedAssets = await prisma.asset.findMany({
  where: { id: { in: referenceMetadata.references.map((reference) => reference.assetId) } },
  include: { selectedImage: true },
})
for (const reference of referenceMetadata.references) {
  const asset = selectedAssets.find((candidate) => candidate.id === reference.assetId)
  if (!asset) throw new Error(`ASSET_NOT_FOUND: ${reference.assetId}`)
  if (asset.selectedImage?.mediaId !== reference.mediaId) {
    throw new Error(`ASSET_REFERENCE_STALE: ${asset.name}`)
  }
}

const storyboardCandidates = await prisma.storyboard.findMany({
  where: {
    assetLinks: {
      some: { assetId: { in: referenceMetadata.references.map((reference) => reference.assetId) } },
    },
  },
  include: { assetLinks: true },
  orderBy: { updatedAt: 'desc' },
})
const storyboard = storyboardCandidates.find((candidate) => referenceMetadata.references.every(
  (reference) => candidate.assetLinks.some((link) => link.assetId === reference.assetId),
))
if (!storyboard) throw new Error('STORYBOARD_WITH_ASSETS_NOT_FOUND')

const keyframe = await readFile(keyframePath)
const referenceDataUrl = `data:image/png;base64,${keyframe.toString('base64')}`
const config: VideoApiConfig = {
  baseUrl: env.videoDirectApiBaseUrl(),
  apiKey: env.videoApiKey(),
  mode: 'newapi-grok',
  model: 'grok-video',
}
const capability = await detectVideoCapability(config)
if (!capability) throw new Error('VIDEO_MODEL_UNAVAILABLE: grok-video')

console.log('Assets verified. Submitting grok-video, 15s, 16:9, 480p, one combined reference frame.')
const submitted = await submitVideoGeneration(config, capability, {
  prompt,
  seconds: 15,
  size: '854x480',
  referenceImageUrls: [referenceDataUrl],
  generateAudio: false,
})
console.log(`Grok task ${submitted.id}: ${submitted.status}`)

const deadline = Date.now() + 35 * 60 * 1000
let current = submitted
while (!['completed', 'failed'].includes(current.status.toLowerCase())) {
  if (Date.now() > deadline) throw new Error(`GROK_TASK_TIMEOUT: ${submitted.id}`)
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  current = await retrieveVideoJob(config, submitted.id)
  console.log(
    `Grok task ${submitted.id}: ${current.status}`
    + (current.progress == null ? '' : ` ${current.progress}%`),
  )
}
if (current.status.toLowerCase() !== 'completed') {
  throw new Error(`GROK_TASK_FAILED: ${JSON.stringify(current.raw)}`)
}

const resultUrl = extractVideoUrl(current.raw)
let bytes: Uint8Array
let mimeType = 'video/mp4'
if (resultUrl) {
  const response = await fetch(resultUrl)
  if (!response.ok) throw new Error(`GROK_DOWNLOAD_FAILED: HTTP ${response.status}`)
  const responseType = response.headers.get('content-type')?.split(';')[0]
  if (responseType?.startsWith('video/')) mimeType = responseType
  bytes = new Uint8Array(await response.arrayBuffer())
} else {
  bytes = await downloadOpenAIVideo(config, submitted.id)
}
if (bytes.byteLength < 1024) throw new Error(`GROK_VIDEO_TOO_SMALL: ${bytes.byteLength} bytes`)

await mkdir(outputDir, { recursive: true })
const outputPath = path.join(outputDir, 'storyboard-real-grok-15s.mp4')
await writeFile(outputPath, bytes)
await writeFile(
  path.join(outputDir, 'storyboard-real-grok-15s.json'),
  JSON.stringify({
    provider: 'cangyuansuanli-direct',
    model: capability.model,
    providerJobId: submitted.id,
    duration: 15,
    resolution: '480p',
    audio: false,
    keyframe: path.basename(keyframePath),
    references: referenceMetadata.references,
    raw: current.raw,
  }, null, 2),
)

const storageKey = buildStoryboardStorageKey({
  projectId: storyboard.projectId,
  storyboardId: storyboard.id,
  mimeType,
})
await uploadBuffer({ key: storageKey, body: Buffer.from(bytes), mimeType })
const video = await prisma.$transaction(async (tx) => {
  const media = await tx.mediaObject.create({
    data: {
      kind: 'video',
      storageKey,
      mimeType,
      sizeBytes: BigInt(bytes.byteLength),
    },
  })
  return tx.storyboardVideo.create({
    data: {
      storyboardId: storyboard.id,
      mediaId: media.id,
      prompt: `[REAL_GROK_ASSET_VIDEO]\n${prompt}`,
      model: capability.model,
      providerJobId: submitted.id,
      duration: 15,
      aspectRatio: '16:9',
      isSelected: false,
    },
  })
})

console.log(`Video saved: ${outputPath}`)
console.log(`Storyboard video created: ${video.id}`)
await prisma.$disconnect()
