import { prisma } from '../src/lib/db'
import { env } from '../src/lib/env'
import { generateTextViaOpenAICompat } from '../src/lib/openai-text'
import { buildNovelChunkAnalysisPrompt, novelAnalysisSystem } from '../src/lib/preproduction-prompts'

function numberArg(name: string, fallback: number) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const chars = numberArg('--chars', 500)
const maxOutputTokens = numberArg('--max-output', 1024)
const effortIndex = process.argv.indexOf('--effort')
const reasoningEffort = effortIndex >= 0 ? process.argv[effortIndex + 1] : 'medium'
const neutralPrompt = process.argv.includes('--neutral')
const source = await prisma.novelSource.findFirst({ orderBy: { updatedAt: 'desc' } })
if (!source) throw new Error('No novel source found')

const text = await generateTextViaOpenAICompat({
  baseUrl: env.textApiBaseUrl(),
  apiKey: env.textApiKey(),
  model: env.textModel(),
  mode: env.textApiMode(),
  reasoningEffort,
  system: neutralPrompt ? '你是一名中文短剧编剧。' : novelAnalysisSystem(),
  prompt: neutralPrompt
    ? `请概括以下故事片段的剧情、人物和对白：\n\n${source.content.slice(0, chars)}`
    : buildNovelChunkAnalysisPrompt({ index: 1, content: source.content.slice(0, chars) }, 1),
  maxOutputTokens,
  temperature: 0.1,
})

console.log(JSON.stringify({
  ok: true,
  chars,
  maxOutputTokens,
  reasoningEffort,
  neutralPrompt,
  outputChars: text.length,
  preview: text.slice(0, 160),
}, null, 2))
await prisma.$disconnect()
