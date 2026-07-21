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
} from '../src/lib/openai-video'
import { downloadBuffer } from '../src/lib/storage'

async function selectedAssetReference(name: string) {
  const asset = await prisma.asset.findFirst({
    where: { name: { contains: name } },
    include: { selectedImage: { include: { media: true } } },
  })
  if (!asset) throw new Error(`ASSET_NOT_FOUND: ${name}`)
  if (!asset.selectedImage?.media) throw new Error(`ASSET_SELECTED_IMAGE_MISSING: ${name}`)

  const media = asset.selectedImage.media
  const bytes = await downloadBuffer(media.storageKey)
  return {
    assetId: asset.id,
    name: asset.name,
    mediaId: media.id,
    dataUrl: `data:${media.mimeType};base64,${bytes.toString('base64')}`,
  }
}

const [mother, daughter] = await Promise.all([
  selectedAssetReference('苏文菁'),
  selectedAssetReference('陈蕊'),
])
console.log(`Asset references loaded: @image1=${mother.name}, @image2=${daughter.name}`)

const config = {
  baseUrl: env.videoApiBaseUrl(),
  apiKey: env.videoApiKey(),
  mode: env.videoApiMode() as 'auto' | 'openai' | 'sub2api-grok' | 'newapi-grok',
  model: 'seedance-2.0-mini',
}
const capability = await detectVideoCapability(config)
if (!capability) throw new Error('VIDEO_MODEL_UNAVAILABLE: seedance-2.0-mini')

const prompt = await readFile(new URL('./storyboard-asset-video-prompt.txt', import.meta.url), 'utf8')
const job = await submitVideoGeneration(config, capability, {
  prompt,
  seconds: 15,
  size: '1280x720',
  referenceImageUrls: [mother.dataUrl, daughter.dataUrl],
  generateAudio: true,
})
console.log(`Video task submitted: ${job.id} (${capability.model}, 15s, two asset references)`)

const deadline = Date.now() + 30 * 60 * 1000
let current = job
while (!['completed', 'failed'].includes(current.status.toLowerCase())) {
  if (Date.now() > deadline) throw new Error(`VIDEO_TASK_TIMEOUT: ${job.id}`)
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  current = await retrieveVideoJob(config, job.id)
  console.log(`Video task ${job.id}: ${current.status}${current.progress == null ? '' : ` ${current.progress}%`}`)
}
if (current.status.toLowerCase() !== 'completed') {
  throw new Error(`VIDEO_TASK_FAILED: ${JSON.stringify(current.raw)}`)
}

const resultUrl = extractVideoUrl(current.raw)
const response = resultUrl
  ? await fetch(resultUrl)
  : null
if (response && !response.ok) {
  throw new Error(`VIDEO_DOWNLOAD_FAILED: HTTP ${response.status}`)
}
const bytes = response
  ? new Uint8Array(await response.arrayBuffer())
  : await downloadOpenAIVideo(config, job.id)

const outputDir = path.resolve('artifacts')
await mkdir(outputDir, { recursive: true })
const outputPath = path.join(outputDir, 'storyboard-assets-15s.mp4')
await writeFile(outputPath, bytes)
await writeFile(path.join(outputDir, 'storyboard-assets-15s.json'), JSON.stringify({
  taskId: job.id,
  model: capability.model,
  duration: 15,
  references: [
    { assetId: mother.assetId, mediaId: mother.mediaId, name: mother.name },
    { assetId: daughter.assetId, mediaId: daughter.mediaId, name: daughter.name },
  ],
}, null, 2))
console.log(`Video saved: ${outputPath}`)
