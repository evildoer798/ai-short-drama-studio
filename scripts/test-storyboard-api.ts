import { prisma } from '../src/lib/db'
import { env } from '../src/lib/env'
import { generateTextViaOpenAICompat, extractJsonValue } from '../src/lib/openai-text'
import { buildStoryboardGenerationPrompt, STORYBOARD_SYSTEM_PROMPT } from '../src/lib/preproduction-prompts'
import { matchStoryboardAssets } from '../src/lib/storyboards'
import {
  compactStoryboardShots,
  fitStoryboardDuration,
  splitStoryboardScript,
  targetStoryboardShotCount,
} from '../src/lib/worker/text-generation'

function numberArg(name: string, fallback: number) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const episodeNumber = numberArg('--episode', 1)
const segmentChars = numberArg('--chars', 320)
const episode = await prisma.scriptEpisode.findFirst({
  where: { locked: true, episodeNumber },
  orderBy: { episodeNumber: 'asc' },
})
if (!episode) throw new Error('No locked episode found')
const project = await prisma.project.findUnique({ where: { id: episode.projectId } })
if (!project) throw new Error('Project not found')
const assets = await prisma.asset.findMany({
  where: { projectId: episode.projectId },
  select: { id: true, type: true, name: true, description: true, tags: true, selectedImageId: true, updatedAt: true },
})
const segments = splitStoryboardScript(episode.content, segmentChars)
const script = segments[0]
const related = matchStoryboardAssets(assets, script, 8)
const targetShotCount = targetStoryboardShotCount(script)
const prompt = buildStoryboardGenerationPrompt({
  episodeNumber: episode.episodeNumber,
  episodeTitle: episode.title,
  script,
  assets: related.map((asset) => ({
    type: asset.type,
    name: asset.name,
    description: asset.description.slice(0, 120),
  })),
  allAssetNames: related.map((asset) => ({ type: asset.type, name: asset.name })),
  visualStyle: project.visualStyle,
  customStylePrompt: project.customStylePrompt,
  targetShotCount,
  segment: { index: 1, total: segments.length },
})
const startedAt = Date.now()
const text = await generateTextViaOpenAICompat({
  baseUrl: env.textApiBaseUrl(),
  apiKey: env.textApiKey(),
  model: env.textModel(),
  mode: env.textApiMode(),
  reasoningEffort: 'low',
  system: STORYBOARD_SYSTEM_PROMPT,
  prompt,
  maxOutputTokens: 2_000,
  temperature: 0.1,
  timeoutMs: 55_000,
  maxAttempts: 1,
})
const parsed = extractJsonValue(text) as { shots?: Array<{
  t: string; n: string; c: string; v: string; a: string; d: number
}> }
const fitted = Array.isArray(parsed.shots)
  ? fitStoryboardDuration(compactStoryboardShots(parsed.shots, targetShotCount), 90)
  : []
console.log(JSON.stringify({
  ok: Array.isArray(parsed.shots) && parsed.shots.length > 0,
  model: env.textModel(),
  episodeNumber: episode.episodeNumber,
  inputChars: script.length,
  promptChars: prompt.length,
  outputChars: text.length,
  targetShotCount,
  rawShotCount: Array.isArray(parsed.shots) ? parsed.shots.length : 0,
  compactedShotCount: fitted.length,
  fittedSeconds: fitted.reduce((total, shot) => total + shot.d, 0),
  elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
}, null, 2))
await prisma.$disconnect()
