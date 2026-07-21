import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../src/lib/db'
import { env } from '../src/lib/env'
import { extractJsonValue, generateTextViaOpenAICompat } from '../src/lib/openai-text'

const projectId = process.argv[2]
if (!projectId) throw new Error('Usage: npm run polish:episodes -- <projectId>')

const titles = new Map<number, string>([
  [1, '夜送翡翠山庄'],
  [2, '推荐信的代价'],
  [3, '无法拒绝的家教'],
  [4, '精心挑选的替代品'],
  [5, '一夜之间一无所有'],
  [6, '最后的机会'],
  [7, '被安排的人生'],
  [8, '捆绑的前途'],
  [9, '临时身份'],
  [10, '危险室友'],
  [11, '一顿早餐'],
  [12, '顶级律所的试探'],
  [13, '悬空的位置'],
  [14, '双重身份'],
  [15, '换装上班'],
])

const resultSchema = z.object({
  episodes: z.array(z.object({
    episodeNumber: z.coerce.number().int().positive(),
    content: z.string().trim().min(500),
  })),
})

function dialogueChars(content: string) {
  return content.split(/\r?\n/)
    .filter((line) => /^[^：:\n]{1,32}(?:【OS】)?[：:]/.test(line.trim()))
    .reduce((sum, line) => sum + line.split(/[：:]/).slice(1).join(':').trim().length, 0)
}

async function polishBatch(episodes: Array<{ episodeNumber: number; logline: string | null; content: string }>) {
  const prompt = `请把以下分集剧本调整为每集约 90 秒的可排演短剧。

制作尺度：每集保留 3 至 4 个场次，正文约 850 至 1150 个汉字；角色对白与【OS】合计约 300 至 420 个汉字。沿用现有事件顺序、人物关系、核心揭示和结尾承接点，用动作与简短台词提高节奏。保持“场次 + 时间/内外景 + 地点 + 动作 + 对白”的剧本格式。

请返回以下结构的 JSON 对象：
{"episodes":[{"episodeNumber":3,"content":"调整后的完整剧本"}]}

【待调整剧本】
${episodes.map((episode) => '\n--- 第 ' + episode.episodeNumber + ' 集 ---\n核心：' + (episode.logline || '') + '\n' + episode.content).join('\n')}

返回数组中的集数与输入保持一致。`

  const text = await generateTextViaOpenAICompat({
    baseUrl: env.textApiBaseUrl(),
    apiKey: env.textApiKey(),
    model: env.textModel(),
    mode: env.textApiMode(),
    system: '你是一名中文短剧编剧和现场执行导演，擅长在保留剧情的同时控制表演时长。',
    prompt,
    maxOutputTokens: 7000,
    temperature: 0.15,
    reasoningEffort: 'low',
  })
  return resultSchema.parse(extractJsonValue(text)).episodes
}

const episodes = await prisma.scriptEpisode.findMany({
  where: { projectId },
  orderBy: { episodeNumber: 'asc' },
  select: { episodeNumber: true, logline: true, content: true },
})
if (episodes.length !== 15) throw new Error(`Expected 15 episodes, found ${episodes.length}`)

const overlong = episodes.filter((episode) => dialogueChars(episode.content) > 500)
const polished = new Map<number, string>()
for (let index = 0; index < overlong.length; index += 3) {
  const batch = overlong.slice(index, index + 3)
  const results = await polishBatch(batch)
  for (const result of results) {
    if (!batch.some((episode) => episode.episodeNumber === result.episodeNumber)) continue
    polished.set(result.episodeNumber, result.content)
  }
  console.log(`Polished ${Math.min(index + batch.length, overlong.length)}/${overlong.length} long episodes`)
}

const task = await prisma.generationTask.findFirst({
  where: { projectId, type: 'script_adaptation' },
  orderBy: { updatedAt: 'desc' },
  select: { id: true, payload: true },
})
const payload = task?.payload && typeof task.payload === 'object' && !Array.isArray(task.payload)
  ? structuredClone(task.payload) as Record<string, unknown>
  : {}
const checkpoint = payload.adaptationCheckpoint && typeof payload.adaptationCheckpoint === 'object' && !Array.isArray(payload.adaptationCheckpoint)
  ? payload.adaptationCheckpoint as Record<string, unknown>
  : null
const drafts = checkpoint && Array.isArray(checkpoint.drafts) ? checkpoint.drafts : []
for (const draft of drafts) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) continue
  const record = draft as Record<string, unknown>
  const episodeNumber = Number(record.episodeNumber)
  record.title = titles.get(episodeNumber) || record.title
  record.content = polished.get(episodeNumber) || record.content
}

await prisma.$transaction(async (tx) => {
  for (const episode of episodes) {
    await tx.scriptEpisode.update({
      where: { projectId_episodeNumber: { projectId, episodeNumber: episode.episodeNumber } },
      data: {
        title: titles.get(episode.episodeNumber) || `第 ${episode.episodeNumber} 集`,
        content: polished.get(episode.episodeNumber) || episode.content,
      },
    })
  }
  if (task) {
    await tx.generationTask.update({
      where: { id: task.id },
      data: { payload: payload as Prisma.InputJsonValue },
    })
  }
})

console.log(JSON.stringify({
  episodeCount: episodes.length,
  polishedEpisodes: [...polished.keys()].sort((a, b) => a - b),
  titles: [...titles.values()],
}, null, 2))
await prisma.$disconnect()
