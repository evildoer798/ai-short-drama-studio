import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../src/lib/db'
import { env } from '../src/lib/env'
import {
  detectVideoCapability,
  downloadOpenAIVideo,
  extractVideoUrl,
  listVideoProviderModels,
  retrieveVideoJob,
  submitVideoGeneration,
  type VideoApiConfig,
} from '../src/lib/openai-video'
import { buildStoryboardStorageKey, uploadBuffer } from '../src/lib/storage'

type PreviewProvider = {
  id: 'grok' | 'seedance'
  label: string
  config: VideoApiConfig
  outputName: string
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const confirmedPaidRun = process.argv.includes('--confirm-paid')
if (!confirmedPaidRun) {
  throw new Error('PAID_GENERATION_CONFIRMATION_REQUIRED: rerun with -- --confirm-paid')
}
const requestedProvider = process.argv
  .find((argument) => argument.startsWith('--provider='))
  ?.split('=')[1]
const prompt = await readFile(new URL('./action-preview-prompt.txt', import.meta.url), 'utf8')
const outputDir = path.resolve('artifacts')
await mkdir(outputDir, { recursive: true })
const grokBaseUrl = env.grokVideoApiBaseUrl()
const sharedVideoProvider = grokBaseUrl === env.videoApiBaseUrl()

const storyboard = await prisma.storyboard.findFirst({
  where: { title: '母女视频通话' },
  orderBy: { updatedAt: 'desc' },
})
if (!storyboard) throw new Error('STORYBOARD_NOT_FOUND: 母女视频通话')
const targetStoryboard = storyboard

const allProviders: PreviewProvider[] = [
  {
    id: 'grok',
    label: 'Grok Imagine Video',
    config: {
      baseUrl: grokBaseUrl,
      apiKey: sharedVideoProvider ? env.videoApiKey() : env.grokVideoApiKey(),
      mode: env.grokVideoApiMode() as VideoApiConfig['mode'],
      model: env.grokVideoModel(),
    },
    outputName: 'action-preview-grok-15s.mp4',
  },
  {
    id: 'seedance',
    label: 'Seedance Mini 480p',
    config: {
      baseUrl: env.videoApiBaseUrl(),
      apiKey: env.videoApiKey(),
      mode: env.videoApiMode() as VideoApiConfig['mode'],
      model: 'seedance-2.0-mini-480p',
    },
    outputName: 'action-preview-seedance-mini-480p-15s.mp4',
  },
]
const providers = requestedProvider
  ? allProviders.filter((provider) => provider.id === requestedProvider)
  : allProviders
if (providers.length === 0) {
  throw new Error(`UNKNOWN_PREVIEW_PROVIDER: ${requestedProvider}`)
}

async function generatePreview(provider: PreviewProvider) {
  const models = await listVideoProviderModels(provider.config)
  const configuredModel = provider.config.model || ''
  if (!models.includes(configuredModel)) {
    throw new Error(`${provider.id.toUpperCase()}_MODEL_UNAVAILABLE: ${configuredModel}`)
  }
  const capability = await detectVideoCapability(provider.config)
  if (!capability) {
    throw new Error(`${provider.id.toUpperCase()}_VIDEO_CAPABILITY_UNAVAILABLE: ${configuredModel}`)
  }

  console.log(`[${provider.id}] submitting ${capability.model}, 15s, 16:9, 480p, audio off`)
  const submitted = await submitVideoGeneration(provider.config, capability, {
    prompt,
    seconds: 15,
    size: '854x480',
    generateAudio: false,
  })
  console.log(`[${provider.id}] task ${submitted.id}: ${submitted.status}`)

  const deadline = Date.now() + 35 * 60 * 1000
  let current = submitted
  while (!['completed', 'failed'].includes(current.status.toLowerCase())) {
    if (Date.now() > deadline) throw new Error(`${provider.id.toUpperCase()}_TASK_TIMEOUT: ${submitted.id}`)
    await sleep(10_000)
    current = await retrieveVideoJob(provider.config, submitted.id)
    console.log(
      `[${provider.id}] task ${submitted.id}: ${current.status}`
      + (current.progress == null ? '' : ` ${current.progress}%`),
    )
  }
  if (current.status.toLowerCase() !== 'completed') {
    throw new Error(`${provider.id.toUpperCase()}_TASK_FAILED: ${JSON.stringify(current.raw)}`)
  }

  const resultUrl = extractVideoUrl(current.raw)
  let bytes: Uint8Array
  let mimeType = 'video/mp4'
  if (resultUrl) {
    const response = await fetch(resultUrl)
    if (!response.ok) throw new Error(`${provider.id.toUpperCase()}_DOWNLOAD_FAILED: HTTP ${response.status}`)
    const responseType = response.headers.get('content-type')?.split(';')[0]
    if (responseType?.startsWith('video/')) mimeType = responseType
    bytes = new Uint8Array(await response.arrayBuffer())
  } else if (capability.mode === 'openai') {
    bytes = await downloadOpenAIVideo(provider.config, submitted.id)
  } else {
    throw new Error(`${provider.id.toUpperCase()}_RESULT_URL_MISSING: ${submitted.id}`)
  }
  if (bytes.byteLength < 1024) {
    throw new Error(`${provider.id.toUpperCase()}_VIDEO_TOO_SMALL: ${bytes.byteLength} bytes`)
  }

  const outputPath = path.join(outputDir, provider.outputName)
  await writeFile(outputPath, bytes)
  await writeFile(
    outputPath.replace(/\.mp4$/i, '.json'),
    JSON.stringify({
      provider: provider.id,
      model: capability.model,
      providerJobId: submitted.id,
      duration: 15,
      resolution: '480p',
      audio: false,
      raw: current.raw,
    }, null, 2),
  )

  const storageKey = buildStoryboardStorageKey({
    projectId: targetStoryboard.projectId,
    storyboardId: targetStoryboard.id,
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
        width: 854,
        height: 480,
      },
    })
    return tx.storyboardVideo.create({
      data: {
        storyboardId: targetStoryboard.id,
        mediaId: media.id,
        prompt: `[ACTION_PREVIEW:${provider.id}]\n${prompt}`,
        model: capability.model,
        providerJobId: submitted.id,
        duration: 15,
        aspectRatio: '16:9',
        isSelected: false,
      },
    })
  })

  console.log(`[${provider.id}] saved ${outputPath} and storyboard video ${video.id}`)
  return { provider: provider.id, outputPath, videoId: video.id, model: capability.model }
}

try {
  const results = await Promise.allSettled(providers.map(generatePreview))
  const summary = results.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : {
        provider: providers[index].id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
  await writeFile(
    path.join(outputDir, 'action-preview-comparison.json'),
    JSON.stringify(summary, null, 2),
  )
  console.log(JSON.stringify(summary, null, 2))
  if (results.some((result) => result.status === 'rejected')) process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
