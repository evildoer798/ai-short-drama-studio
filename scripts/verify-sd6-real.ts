import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import {
  downloadOpenAIVideo,
  extractVideoUrl,
  retrieveVideoJob,
  selectVideoCapability,
  submitVideoGeneration,
} from '@/lib/openai-video'
import { buildStoryboardStorageKey, uploadBuffer } from '@/lib/storage'
import { resolveVideoApiProvider } from '@/lib/video-api-pool'

const model = 'sd6-seedance-2.0-720p'
const storyboardId = process.env.SD6_STORYBOARD_ID?.trim()
const referenceUrl = process.env.SD6_REFERENCE_URL?.trim()

if (!storyboardId) throw new Error('SD6_STORYBOARD_ID is required')
if (!referenceUrl) throw new Error('SD6_REFERENCE_URL is required')

const storyboard = await prisma.storyboard.findUnique({
  where: { id: storyboardId },
  select: {
    id: true,
    projectId: true,
    selectedVideoId: true,
    videoPrompt: true,
  },
})
if (!storyboard) throw new Error(`Storyboard not found: ${storyboardId}`)

const configuredMode = env.videoApiMode() as 'auto' | 'openai' | 'sub2api-grok' | 'newapi-grok'
const provider = await resolveVideoApiProvider({
  baseUrl: env.videoApiBaseUrl(),
  model,
  mode: configuredMode,
  forceRefresh: true,
})
const capability = selectVideoCapability([model], model, configuredMode)
if (!provider || !capability) throw new Error(`Video model unavailable: ${model}`)

const prompt = storyboard.videoPrompt?.trim()
  || 'A restrained live-action performance by an apartment window at dawn.'
const submitted = await submitVideoGeneration(provider.config, capability, {
  prompt,
  seconds: 4,
  size: '1280x720',
  aspectRatio: '16:9',
  resolution: '720p',
  referenceImageUrls: [referenceUrl],
  maximumReferenceImages: 9,
  generateAudio: false,
})

console.log(JSON.stringify({
  phase: 'submitted',
  model,
  providerJobId: submitted.id,
  providerKeySlot: provider.keySlot,
  status: submitted.status,
}))

const deadline = Date.now() + 15 * 60 * 1000
let current = submitted
while (!['completed', 'failed'].includes(current.status.toLowerCase())) {
  if (Date.now() > deadline) throw new Error(`Video task timeout: ${submitted.id}`)
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  current = await retrieveVideoJob(provider.config, submitted.id)
  console.log(JSON.stringify({
    phase: 'polling',
    providerJobId: submitted.id,
    status: current.status,
    progress: current.progress ?? null,
  }))
}

if (current.status.toLowerCase() !== 'completed') {
  const error = current.raw.error
  const errorMessage = error && typeof error === 'object' && !Array.isArray(error)
    ? String((error as Record<string, unknown>).message || '')
    : ''
  throw new Error(errorMessage || String(current.raw.fail_reason || 'Provider video task failed'))
}

const resultUrl = extractVideoUrl(current.raw)
let bytes: Uint8Array
let mimeType = 'video/mp4'
if (resultUrl) {
  const response = await fetch(resultUrl)
  if (!response.ok) throw new Error(`Video download failed: HTTP ${response.status}`)
  mimeType = response.headers.get('content-type')?.split(';')[0] || mimeType
  bytes = new Uint8Array(await response.arrayBuffer())
} else {
  bytes = await downloadOpenAIVideo(provider.config, submitted.id)
}

if (!mimeType.startsWith('video/')) mimeType = 'video/mp4'
const storageKey = buildStoryboardStorageKey({
  projectId: storyboard.projectId,
  storyboardId: storyboard.id,
  mimeType,
})
await uploadBuffer({
  key: storageKey,
  body: Buffer.from(bytes),
  mimeType,
})

const stored = await prisma.$transaction(async (tx) => {
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
  const video = await tx.storyboardVideo.create({
    data: {
      storyboardId: storyboard.id,
      sourceStoryboardIds: [storyboard.id],
      mediaId: media.id,
      prompt,
      model,
      providerJobId: submitted.id,
      duration: 4,
      aspectRatio: '16:9',
      isSelected: !storyboard.selectedVideoId,
    },
  })
  if (!storyboard.selectedVideoId) {
    await tx.storyboard.update({
      where: { id: storyboard.id },
      data: { selectedVideoId: video.id },
    })
  }
  return { mediaId: media.id, videoId: video.id }
})

console.log(JSON.stringify({
  phase: 'completed',
  model,
  providerJobId: submitted.id,
  duration: 4,
  resolution: '720p',
  bytes: bytes.byteLength,
  ...stored,
}))

await prisma.$disconnect()
