import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../src/lib/env'
import {
  detectVideoCapability,
  downloadOpenAIVideo,
  extractVideoUrl,
  listVideoProviderModels,
  retrieveVideoJob,
  submitVideoGeneration,
} from '../src/lib/openai-video'

const config = {
  baseUrl: env.videoApiBaseUrl(),
  apiKey: env.videoApiKey(),
  mode: env.videoApiMode() as 'auto' | 'openai' | 'sub2api-grok' | 'newapi-grok',
  model: env.videoModel(),
}

const models = await listVideoProviderModels(config)
const capability = await detectVideoCapability(config)
if (!capability) {
  const visibleModels = models.filter((model) => /sora|video|grok-imagine/i.test(model))
  throw new Error(
    `VIDEO_MODEL_UNAVAILABLE: provider exposes no supported video model. Candidates: ${visibleModels.join(', ') || 'none'}`,
  )
}

const prompt = await readFile(new URL('./video-test-prompt.txt', import.meta.url), 'utf8')
const job = await submitVideoGeneration(config, capability, {
  prompt,
  seconds: env.videoSeconds(),
  size: env.videoSize(),
})
console.log(`Video task submitted: ${job.id} (${capability.model})`)

const deadline = Date.now() + 20 * 60 * 1000
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
if (capability.mode !== 'openai') {
  throw new Error('VIDEO_DOWNLOAD_UNSUPPORTED: Grok response requires a provider media URL')
}

const resultUrl = extractVideoUrl(current.raw)
const bytes = resultUrl
  ? new Uint8Array(await (await fetch(resultUrl)).arrayBuffer())
  : await downloadOpenAIVideo(config, job.id)
const outputDir = path.resolve('artifacts')
await mkdir(outputDir, { recursive: true })
const outputPath = path.join(outputDir, 'storyboard-video-test.mp4')
await writeFile(outputPath, bytes)
console.log(`Video saved: ${outputPath}`)
