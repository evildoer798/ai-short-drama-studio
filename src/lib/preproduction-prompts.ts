import { AssetType, VisualStyle } from '@prisma/client'
import {
  SCRIPT_COLD_OPEN_START,
  SCRIPT_ENDING_HOOK,
  SCRIPT_MAIN_TIMELINE_START,
} from './script-quality'
import { buildStyleLock, getVisualStylePreset } from './visual-styles'

export type NovelChunk = {
  index: number
  content: string
}

export type SourceDialogue = {
  text: string
  context: string
}

export type SeriesBible = {
  characters: Array<{
    canonicalName: string
    aliases: string[]
    identity: string
    relationships: string[]
  }>
  continuityRules: string[]
}

export type CharacterNameMapping = {
  observedName: string
  canonicalName: string
}

const EXPLICIT_INTIMACY_EVIDENCE = /(?:做爱|性交|性行为|性关系|性交易|口交|手淫|射精|精液|阴茎|阴道|阴部|下体|乳头|乳房|裸体|赤裸|高潮|勃起|抽插|陪睡|床伴|情妇|包养|肉体交易|插入.{0,8}(?:身体|下身)|呻吟|喘息|脱(?:掉|下|光).{0,12}(?:内衣|内裤|胸罩|裤子|衬衫)|解开.{0,12}(?:内衣|内裤|裤链|腰带)|舔舐|吮吸|跨坐|双腿.{0,12}(?:夹|缠)|身体.{0,12}(?:贴紧|纠缠|压住)|手.{0,8}滑向|衬衫.{0,8}(?:敞开|扣子)|衣襟.{0,8}(?:散开|敞开))/iu
const SAFE_INTIMACY_EVIDENCE = '【原文含成年人亲密关系情节：保留人物关系变化、交易代价和事后影响；改编时只用关门、转场、环境与事后状态表达，禁止描写身体部位或具体性行为。】'

export function sanitizeNovelEvidenceForTextPrompt(content: string) {
  const segments = content.split(/(?<=[。！？!?；;，,])|\r?\n/gu)
  const sensitiveIndexes = segments.flatMap((segment, index) => (
    EXPLICIT_INTIMACY_EVIDENCE.test(segment) ? [index] : []
  ))
  if (sensitiveIndexes.length === 0) return content

  const first = Math.max(0, sensitiveIndexes[0] - 6)
  const last = Math.min(segments.length - 1, sensitiveIndexes[sensitiveIndexes.length - 1] + 10)
  return [
    ...segments.slice(0, first),
    SAFE_INTIMACY_EVIDENCE,
    ...segments.slice(last + 1),
  ].join('\n').replace(/\n{3,}/gu, '\n\n')
}

export function splitNovelIntoChunks(content: string, maxChars = 14000): NovelChunk[] {
  const paragraphs = content.replace(/\r\n/g, '\n').split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''

  function flush() {
    if (!current.trim()) return
    chunks.push(current.trim())
    current = ''
  }

  for (const paragraph of paragraphs.length ? paragraphs : [content.trim()]) {
    if (paragraph.length > maxChars) {
      flush()
      for (let start = 0; start < paragraph.length; start += maxChars) {
        chunks.push(paragraph.slice(start, start + maxChars))
      }
      continue
    }
    if (current && current.length + paragraph.length + 2 > maxChars) flush()
    current += `${current ? '\n\n' : ''}${paragraph}`
  }
  flush()
  return chunks.map((chunk, index) => ({ index: index + 1, content: chunk }))
}

export function extractSourceDialogues(content: string): SourceDialogue[] {
  const results: SourceDialogue[] = []
  const seen = new Set<string>()
  const patterns = [/“([^”]{1,500})”/g, /「([^」]{1,500})」/g, /『([^』]{1,500})』/g]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const text = match[1].trim()
      const key = text.replace(/\s+/g, '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      const index = match.index || 0
      results.push({
        text,
        context: content.slice(Math.max(0, index - 80), Math.min(content.length, index + match[0].length + 80)),
      })
    }
  }
  return results
}

export function dialogueMissing(content: string, dialogue: string) {
  const normalize = (value: string) => value.replace(/[\s“”「」『』'"，。！？：；、,.!?:;]/g, '')
  const source = normalize(dialogue)
  return source.length >= 2 && !normalize(content).includes(source)
}

export function extractScriptDialogueLines(content: string) {
  return content.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([^：:\n【]{1,32})(【OS】)?[：:]\s*(.{1,800})$/)
    if (!match) return []
    const speaker = match[1].trim()
    if (/^(场次|时间|地点|内景|外景|画面|动作|场景|备注|音效)$/.test(speaker)) return []
    return [{ speaker, os: Boolean(match[2]), text: match[3].trim() }]
  })
}

const STORYBOARD_VOICEOVER_LABELS = /^(旁白|画外音|解说|内心独白|旁白音)$/u

export function isStoryboardVoiceover(dialogue: { speaker: string; os: boolean }) {
  return dialogue.os || STORYBOARD_VOICEOVER_LABELS.test(dialogue.speaker.trim())
}

export function extractRequiredStoryboardDialogueLines(content: string) {
  return extractScriptDialogueLines(content).filter((dialogue) => !isStoryboardVoiceover(dialogue))
}

const GENERIC_CHARACTER_LABELS = new Set([
  '旁白', '画外音', '系统音', '广播', '电话音', '众人',
  '男人', '女人', '男孩', '女孩', '少年', '少女',
  '母亲', '父亲', '妈妈', '爸爸', '女儿', '儿子',
  '医生', '护士', '老师', '同学', '店员', '司机', '助理', '保镖', '警察',
])
const SCRIPT_META_LABELS = new Set(['场次', '时间', '地点', '内景', '外景', '画面', '动作', '场景', '备注', '音效'])

function replaceAllLiteral(content: string, search: string, replacement: string) {
  return search ? content.split(search).join(replacement) : content
}

export function canonicalizeScriptCharacterNames(
  content: string,
  mappings: CharacterNameMapping[],
) {
  const direct = new Map(mappings
    .map((item) => [item.observedName.trim(), item.canonicalName.trim()] as const)
    .filter(([observed, canonical]) => observed && canonical && observed !== canonical))

  function canonicalName(name: string) {
    let current = name
    const visited = new Set<string>()
    while (direct.has(current) && !visited.has(current)) {
      visited.add(current)
      current = direct.get(current) || current
    }
    return current
  }

  const resolved = [...direct.entries()]
    .map(([observedName, value]) => ({ observedName, canonicalName: canonicalName(value) }))
    .filter((item) => item.observedName !== item.canonicalName)
    .sort((a, b) => b.observedName.length - a.observedName.length)
  if (resolved.length === 0) return content

  const canonicalNames = [...new Set(resolved.map((item) => item.canonicalName))]
    .sort((a, b) => b.length - a.length)

  return content.split(/\r?\n/).map((line) => {
    const dialogue = line.match(/^(\s*)([^：:\n【]{1,32})(【OS】)?([：:])(.*)$/)
    if (dialogue && !SCRIPT_META_LABELS.has(dialogue[2].trim())) {
      const speaker = dialogue[2].trim()
      const mapped = canonicalName(speaker)
      return `${dialogue[1]}${mapped}${dialogue[3] || ''}${dialogue[4]}${dialogue[5]}`
    }

    const placeholders = new Map<string, string>()
    let normalized = line
    canonicalNames.forEach((name, index) => {
      const placeholder = `__CANONICAL_CHARACTER_${index}__`
      placeholders.set(placeholder, name)
      normalized = replaceAllLiteral(normalized, name, placeholder)
    })
    for (const mapping of resolved) {
      if (GENERIC_CHARACTER_LABELS.has(mapping.observedName)) continue
      normalized = replaceAllLiteral(normalized, mapping.observedName, mapping.canonicalName)
    }
    for (const [placeholder, name] of placeholders) {
      normalized = replaceAllLiteral(normalized, placeholder, name)
    }
    return normalized
  }).join('\n')
}

const DIRECTOR_SYSTEM = `你是一名中文短剧编剧和制片统筹。请把故事整理为可排演、可继续拆分镜的分集剧本。以原文的事件顺序、人物关系、因果、信息揭示和对白为制作依据，使用具体、可见、可表演的表达。`

export function novelAnalysisSystem() {
  return DIRECTOR_SYSTEM
}

export function buildNovelChunkAnalysisPrompt(chunk: NovelChunk, totalChunks: number) {
  return `这是小说第 ${chunk.index}/${totalChunks} 个连续片段。请整理一份供后续分集写作使用的详细制作笔记。

制作笔记包含以下栏目：
1. 剧情进展：按发生顺序记录事件、因果、信息揭示和场景变化。
2. 对白清单：按原文记录片段中的人物对白，并标注说话者与邻近语境。
3. 人物状态：记录身份、关系、外观、服装、动作、情绪变化与人物弧光信息。
4. 场景道具：记录固定空间特征、具体时间、氛围和出现的道具。
5. 连续性：记录与前后片段衔接的悬念、正在进行的动作和连续性事实。

请用简洁中文输出上述制作笔记，总长度控制在 800 至 1200 个汉字。

【小说原文片段 ${chunk.index}】
${chunk.content}`
}

function formatSeriesBible(seriesBible: SeriesBible) {
  const characters = seriesBible.characters.length
    ? seriesBible.characters.map((character) => (
        `- 标准姓名：${character.canonicalName}｜允许别名：${character.aliases.join('、') || '无'}｜身份：${character.identity}｜关系：${character.relationships.join('；') || '无'}`
      )).join('\n')
    : '- 尚未识别到明确角色'
  const continuity = seriesBible.continuityRules.length
    ? seriesBible.continuityRules.map((rule) => `- ${rule}`).join('\n')
    : '- 严格沿用原文事件顺序和人物关系'
  return `【全剧唯一人物名册】
${characters}

【全剧连续性事实】
${continuity}`
}

export function buildSeriesBiblePrompt(input: {
  analyses: Array<{ index: number; analysis: string }>
  sourceExcerpts: Array<{ index: number; content: string }>
}) {
  return `请先为整部短剧建立一份后续所有分集都必须遵守的“全剧人物与连续性圣经”。

硬性规则：
1. characters 必须覆盖原文中每一个有姓名、固定称谓或实际说话的角色，包括配角。
2. canonicalName 必须选择原文中最完整、最稳定的姓名；同一人物的英文名、昵称、旧称放入 aliases，不得另造姓名。
3. 不得把两个不同人物合并；“母亲、医生、店员”等泛称不能作为 aliases，身份不明时使用原文稳定称谓。
4. continuityRules 记录跨集不能改变的身份、关系、已知信息、关键道具归属、持续动作和时间顺序。
5. 只输出严格 JSON，不要解释或 Markdown。

输出格式：
{"characters":[{"canonicalName":"原文标准姓名","aliases":["原文别名"],"identity":"身份事实","relationships":["与其他标准姓名的关系"]}],"continuityRules":["跨集连续性事实"]}

【分片制作笔记】
${input.analyses.map((item) => `--- 片段 ${item.index} ---\n${item.analysis}`).join('\n')}

【原文证据摘录】
${input.sourceExcerpts.map((item) => `--- 片段 ${item.index} ---\n${item.content}`).join('\n')}`
}

export function buildSeriesBibleMergePrompt(input: {
  parts: Array<{
    sourceChunkIndexes: number[]
    bible: SeriesBible
  }>
}) {
  return `以下内容是同一部小说按连续章节分批提取的人物名册与连续性事实。请合并为一份后续所有分集必须遵守的“全剧人物与连续性圣经”。

硬性规则：
1. 同一人物只保留一个 canonicalName；英文名、昵称、旧称全部移入 aliases。
2. 不得漏掉任一批次中有姓名、固定称谓或实际说话的角色，也不得把不同人物误合并。
3. identity 与 relationships 合并互补事实，删除重复和冲突表述，不得编造原文外信息。
4. continuityRules 合并跨集身份、关系、道具归属、持续动作与时间顺序，删除重复项。
5. 只输出严格 JSON，不要解释或 Markdown。

输出格式：
{"characters":[{"canonicalName":"原文标准姓名","aliases":["原文别名"],"identity":"身份事实","relationships":["与其他标准姓名的关系"]}],"continuityRules":["跨集连续性事实"]}

【分批提取结果】
${input.parts.map((part) => (
    `--- 原文片段 ${part.sourceChunkIndexes.join('、')} ---\n${JSON.stringify(part.bible)}`
  )).join('\n')}`
}

export function buildEpisodePlanPrompt(input: {
  analyses: Array<{ index: number; analysis: string }>
  targetEpisodeCount: number
  episodeMinutes: number
  seriesBible: SeriesBible
}) {
  return `根据以下按原文顺序排列的制作笔记，把整部内容规划为 ${input.targetEpisodeCount} 集、每集约 ${input.episodeMinutes} 分钟的短剧。

规划方法：
- 将制作笔记中的剧情事件与对白完整分配到各集，沿用人物关系、因果和信息揭示顺序。
- 每个原文事件只能归属于一集。相邻集只继承人物状态、未完成悬念和已知信息，严禁复演、回顾或改写上一集已经完成的动作、对白与揭示。
- 每集设置清晰的开场任务、冲突推进、情绪转折和源于原文情节的结尾 Hook；每一集都必须有新的事件推进，不能只重复上集结果。
- 连续动作安排在相邻段落中，清楚区分回忆与现实。
- 所有人物只能使用全剧唯一人物名册中的标准姓名，禁止在不同集改名或把别名当作新人物。
- openingContinuity 写明本集开场继承的角色位置、情绪、持有道具和已知信息；endingContinuity 写明必须交给下一集的状态与悬念。
- sourceChunks 列出该集拥有改编权的片段编号。每个片段必须且只能分配给一集，相邻集不得共用片段；连续性事实写入 openingContinuity/endingContinuity，不能靠重复原文解决。
- 第 1 集先用一个来自后续高冲突情节的短促倒叙冷开场吸引观众，隐去结果后立即回到原著开端；冷开场不是完整复演，后续正式演到该事件时仍须呈现完整因果。
- 第 1 至 3 集必须快速进入核心矛盾：第 1 集在前 20 秒触发主角困境，第 2 集升级代价或阻力，第 3 集形成不可轻易撤回的选择或后果，禁止用大段背景介绍拖延主线。
- 每集 endingContinuity 必须是可拍摄的危机、选择、新信息、关系变化或即将发生的动作，不得写“敬请期待”等说明性套话。
- episodes 数组包含恰好 ${input.targetEpisodeCount} 项，episodeNumber 从 1 连续排列到 ${input.targetEpisodeCount}。

请返回以下结构的 JSON 对象：
{"episodes":[{"episodeNumber":1,"title":"集名","logline":"本集核心推进","sourceChunks":[1,2],"contentGoals":["必须呈现的事件或对白"],"openingContinuity":"从上集继承的状态","endingContinuity":"交给下集的状态"}]}

${sanitizeNovelEvidenceForTextPrompt(formatSeriesBible(input.seriesBible))}

【制作笔记】
${input.analyses.map((item) => `\n--- 片段 ${item.index} ---\n${sanitizeNovelEvidenceForTextPrompt(item.analysis)}`).join('\n')}`
}

export function buildEpisodeDraftPrompt(input: {
  episodeNumber: number
  title: string
  logline: string
  episodeMinutes: number
  goals: string[]
  sourceText: string
  analyses: string
  sourceDialogues: SourceDialogue[]
  seriesBible: SeriesBible
  openingContinuity: string
  endingContinuity: string
  previousEpisode?: { title: string; logline: string; endingExcerpt: string }
  nextEpisode?: { title: string; logline: string; openingContinuity: string }
  flashforwardCandidates?: string
}) {
  return `请依据原文取材与制作笔记，写第 ${input.episodeNumber} 集可供演员排演和后续分镜拆解的短剧剧本。

本集标题参考：${input.title}
本集核心：${input.logline}
目标时长：约 ${input.episodeMinutes} 分钟
成片尺度：约 ${Math.round(input.episodeMinutes * 60)} 秒，正文硬性控制在 ${Math.max(500, Math.round(input.episodeMinutes * 500))} 至 ${Math.max(800, Math.round(input.episodeMinutes * 750))} 个汉字，安排 2 至 4 个场次；先在内部压缩再输出，content 超过上限即视为失败，禁止输出字数统计过程
本集内容目标：${input.goals.join('；') || '按原文顺序完整推进'}
本集开场连续性：${input.openingContinuity || '按原文承接上一集'}
本集结尾交接：${input.endingContinuity || '按原文自然承接下一集'}

写作格式：
1. 采用“场次 + 时间/内外景 + 地点 + 动作 + 对白”的剧本结构，镜头参数留到后续分镜阶段处理。
2. 按剧情顺序提炼本章的关键事件、人物关系和信息揭示；优先沿用推动剧情的原文对白，并用必要动作连接。
3. 将叙述优先改写为可见动作、表情、视线、环境反应或人物现场对白。原则上不写旁白；只有人物无法说出口、画面无法表达且删去会导致关键信息断裂时，才允许使用一句简短【OS】，不得用【OS】重复解释画面已经表现的内容。
4. 清楚标记人物出场、转场和时间变化；人物使用全名。每个物理拍摄空间建立一个至少四个字的全剧唯一标准场景名，场次标题和正文每次出现都逐字复用该名称；同一空间不得换简称或近义名，不同空间不得共用名称。场景结构、固定陈设、材质和基础光线沿用一致描述。
5. 对白格式为“人物全名：对白”；内心独白格式为“人物全名【OS】：内容”。
6. 结尾落在规划中的剧情承接点，正文使用场次而非分镜编号。最后必须单独写 ${SCRIPT_ENDING_HOOK}，其后用一个正在发生的动作、一句关键对白、突然出现的新信息、迫近危机或两难选择结束；Hook 属于剧情正文，不得写“下集预告”“敬请期待”或解释为什么有悬念。
7. 根据本集核心冲突拟定一个 6 至 12 个汉字的剧情标题，写入返回对象的 title 字段。
8. 所有场次、动作和说话人标签只能使用“全剧唯一人物名册”的标准姓名；别名只允许在原文对白内容内部自然出现，不得作为说话人姓名。
9. 若提供上一集结尾，只能继承人物位置、动作未完成部分、情绪、道具归属和已知信息。上一集结尾仅是连续性证据，严禁逐句复制、概述、闪回或再次表演其中已经完成的动作、对白和信息揭示；本集第一句剧情必须发生在上一集最后一个已完成动作之后。
10. 只允许改编“本集原文取材”中的事件和对白。相邻集信息只用于边界校验，严禁提前取用下一集事件；结尾必须完成本集内容目标并准确落到下一集开场条件，不得提前演完下一集剧情。
11. ${input.episodeNumber === 1
    ? `第一集必须在标题之后先写 ${SCRIPT_COLD_OPEN_START}，从下方候选中选择一个后续高冲突瞬间，用约 6 至 12 秒、80 至 160 个汉字呈现危机片段，但不能交代结果或完整复演；随后明确写 ${SCRIPT_MAIN_TIMELINE_START}，回到原著开端，并在前 20 秒触发主角当前困境。`
    : `本集不得使用 ${SCRIPT_COLD_OPEN_START}，开场直接承接上一集 Hook 之后的新动作，不得重播 Hook。`}
12. 第 1 至 3 集压缩背景介绍，把身份信息分散到冲突动作和必要对白中；第 1 集触发核心矛盾，第 2 集让代价升级，第 3 集让主角作出难以撤回的选择。其他集也必须在开场 10 秒内出现本集目标或阻力。
13. 严格遵守约 ${Math.round(input.episodeMinutes * 60)} 秒尺度，不得为了“完整”擅自写入下一集内容，也不得用重复场面凑时长。

${sanitizeNovelEvidenceForTextPrompt(formatSeriesBible(input.seriesBible))}

【相邻分集上下文】
${input.previousEpisode
    ? `上一集《${input.previousEpisode.title}》核心：${sanitizeNovelEvidenceForTextPrompt(input.previousEpisode.logline)}\n上一集连续性尾帧（只可承接状态，禁止复制或复演）：\n${sanitizeNovelEvidenceForTextPrompt(input.previousEpisode.endingExcerpt)}`
    : '这是第一集，没有上一集。'}

${input.nextEpisode
    ? `下一集《${input.nextEpisode.title}》核心：${sanitizeNovelEvidenceForTextPrompt(input.nextEpisode.logline)}\n下一集专属开场条件（只用于停止本集，禁止提前演出）：${sanitizeNovelEvidenceForTextPrompt(input.nextEpisode.openingContinuity)}`
    : '这是最后一集，按原文完成收束。'}

${input.episodeNumber === 1
    ? `【第一集倒叙冷开场候选｜仅选一个片段的危机瞬间，不得交代完整结果】\n${input.flashforwardCandidates || '从全剧人物与连续性圣经中选择后续高冲突事实，但不得编造。'}`
    : ''}

【本集原文对白参考】
${input.sourceDialogues.length ? input.sourceDialogues.map((item) => `- ${item.text}\n  原文邻近语境：${item.context}`).join('\n') : '- 本段没有引号对白，以原文实际内容为准'}

【原文取材】
${input.sourceText}

【制作笔记】
${sanitizeNovelEvidenceForTextPrompt(input.analyses)}

请返回以下结构的 JSON 对象：
{"title":"本集标题","logline":"一句话核心","content":"完整分集剧本"}`
}

export function buildEpisodeQualityRepairPrompt(input: {
  episodeNumber: number
  episodeMinutes: number
  title: string
  logline: string
  content: string
  issues: string[]
  sourceText: string
  seriesBible: SeriesBible
  previousEpisode?: { title: string; endingExcerpt: string }
  nextEpisode?: { title: string; openingContinuity: string; forbiddenExcerpt?: string }
  flashforwardCandidates?: string
}) {
  const minimumChars = Math.max(500, Math.round(input.episodeMinutes * 500))
  const maximumChars = Math.max(800, Math.round(input.episodeMinutes * 750))
  const hasLengthIssue = input.issues.some((issue) => /字|时长|过长|过短/u.test(issue))
  const hasDuplicateIssue = input.issues.some((issue) => /重复|复演|上一集/u.test(issue))
  return `你是短剧剧本终检修订师。下面第 ${input.episodeNumber} 集没有通过自动质量检查，请一次性重写为可直接保存的合格版本。

【必须修复的问题】
${input.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

硬性边界：
1. 只保留本集原文证据中的事件、对白和因果。本集之外的事件一律删除，不得用上一集或下一集剧情凑时长。
2. 上一集材料只用于确认开场状态；从上一集最后一个已完成动作之后开始，禁止复制、概述、闪回或复演上一集的动作、对白和信息揭示。
3. 下一集材料是禁区，只用于识别停止位置；不得提前演出其动作、对白、揭示或结果。
4. 正文硬性控制在 ${minimumChars} 至 ${maximumChars} 个汉字、2 至 4 个场次，保持“场次 + 时间/内外景 + 标准地点 + 动作 + 对白”的剧本结构。先在内部完成字数压缩再输出，content 超过 ${maximumChars} 个汉字即视为修订失败；禁止输出字数统计过程。
5. 所有角色使用全剧标准姓名，叙述改为可见动作与现场对白，非必要不使用旁白或【OS】。
6. 结尾必须单独写 ${SCRIPT_ENDING_HOOK}，用剧情中的危机、选择、新信息、关系变化或未完成动作结束；禁止“敬请期待”“下集预告”等说明性套话。
7. ${input.episodeNumber === 1
    ? `标题后先写 ${SCRIPT_COLD_OPEN_START}，从候选中选一个后续高冲突瞬间，控制在 80 至 160 个汉字且不交代结果；紧接着写 ${SCRIPT_MAIN_TIMELINE_START} 回到原著开端，前 20 秒触发核心矛盾。`
    : `不得写 ${SCRIPT_COLD_OPEN_START}；开场直接产生新动作，不重播上一集 Hook。`}
8. 第 1 至 3 集快速进入主线：第 1 集触发困境，第 2 集升级代价，第 3 集形成难以撤回的选择或后果。
${hasLengthIssue
    ? `9. 本次最高优先级是压缩时长：删除景物堆砌、重复心理说明、同义动作和不推动冲突的对白；同一信息只表达一次。必须保留核心事件与因果，但不能逐句搬运原文。最终 content 绝不能超过 ${maximumChars} 个汉字。`
    : ''}
${hasDuplicateIssue
    ? '10. 本次最高优先级还包括删除跨集重复：当前版本中凡是在上一集连续性证据里已经出现过的场景建立、动作、对白和揭示，必须整段删除，不能换词改写后保留。本集直接从第一个未在上一集出现的新动作开始。'
    : ''}

${sanitizeNovelEvidenceForTextPrompt(formatSeriesBible(input.seriesBible))}

【上一集连续性尾帧｜只承接状态】
${input.previousEpisode ? `《${input.previousEpisode.title}》\n${sanitizeNovelEvidenceForTextPrompt(input.previousEpisode.endingExcerpt)}` : '无，当前为第一集。'}

【下一集禁区｜不得提前演出】
${input.nextEpisode
    ? `《${input.nextEpisode.title}》开场条件：${sanitizeNovelEvidenceForTextPrompt(input.nextEpisode.openingContinuity)}\n${sanitizeNovelEvidenceForTextPrompt(input.nextEpisode.forbiddenExcerpt || '')}`
    : '无，当前为最后一集。'}

${input.episodeNumber === 1 ? `【倒叙冷开场候选】\n${input.flashforwardCandidates || '严格依据全剧事实选择后续高冲突瞬间。'}` : ''}

【本集唯一原文证据】
${input.sourceText}

【当前待修订版本】
标题：${input.title}
核心：${input.logline}
${sanitizeNovelEvidenceForTextPrompt(input.content)}

只返回严格 JSON：
{"title":"修订后的本集标题","logline":"修订后的一句话核心","content":"修订后的完整分集剧本"}`
}

export function buildCharacterNameAuditPrompt(input: {
  seriesBible: SeriesBible
  observed: Array<{ name: string; episodes: number[]; examples: string[] }>
}) {
  return `你是全剧人物姓名一致性审校员。请检查各集实际使用的说话人姓名，识别同一人物被写成不同姓名、英文名、昵称或简称的情况。

规则：
- mappings 只列“确认属于同一人物且需要统一”的项目；不同人物绝不能合并。
- observedName 必须逐字取自实际说话人清单。
- canonicalName 优先逐字选用全剧唯一人物名册中的标准姓名；名册遗漏的独立配角可保留原名，不要输出映射。
- 旁白、系统音、广播等声音标签不映射为人物。
- 只输出严格 JSON：{"mappings":[{"observedName":"实际姓名","canonicalName":"标准姓名","reason":"同一人物证据"}]}

${sanitizeNovelEvidenceForTextPrompt(formatSeriesBible(input.seriesBible))}

【各集实际说话人】
${input.observed.map((item) => `- ${item.name}｜出现集数：${item.episodes.join('、')}｜示例：${item.examples.join('；')}`).join('\n')}`
}

export function buildDialogueRepairPrompt(input: {
  episodeContent: string
  missingDialogues: SourceDialogue[]
}) {
  return `请把对白清单中尚未出现在剧本里的句子，安排到对应人物、场次和动作语境中。沿用现有剧本的情节、场次和表达，并返回整合后的完整剧本。

【待整合对白】
${input.missingDialogues.map((item) => `- ${item.text}\n  语境：${item.context}`).join('\n')}

现有剧本：
${input.episodeContent}

请返回 JSON 对象：{"content":"整合后的完整剧本"}`
}

export function buildEpisodeRevisionPrompt(input: {
  title: string
  content: string
  comments: Array<{ quotedText: string; instruction: string }>
  seriesBible?: SeriesBible
  previousEpisode?: { title: string; endingExcerpt: string }
  nextEpisode?: { title: string; openingExcerpt: string }
}) {
  return `请根据导演评论修订分集剧本《${input.title}》。

修订方式：聚焦评论涉及的细节，沿用其余剧情、场次、人物关系和对白。保持分集剧本格式。评论与原著事实存在分歧时，在 content 末尾添加“【待确认】”及简要说明。
姓名与连续性硬约束：说话人和动作叙述必须沿用全剧标准姓名，不得把英文名、昵称或称谓写成新的角色姓名；开头不得破坏上一集结尾状态，结尾不得破坏下一集开场状态。

${input.seriesBible ? sanitizeNovelEvidenceForTextPrompt(formatSeriesBible(input.seriesBible)) : '【全剧人物名册】\n沿用当前剧本和相邻集已经使用的完整姓名。'}

【相邻集参考】
${input.previousEpisode ? `上一集《${input.previousEpisode.title}》结尾：\n${input.previousEpisode.endingExcerpt}` : '这是第一集。'}

${input.nextEpisode ? `下一集《${input.nextEpisode.title}》开头：\n${input.nextEpisode.openingExcerpt}` : '这是最后一集。'}

导演评论：
${input.comments.map((comment, index) => `${index + 1}. 选中文本：${comment.quotedText}\n   修改意见：${comment.instruction}`).join('\n')}

当前完整剧本：
${input.content}

请返回 JSON 对象：{"content":"修订后的完整剧本"}`
}

const CHARACTER_PROMPT_RULES = `人物设定图必须以白色背景身份卡呈现：上方为正面、侧面、背面三个全身核心视角，完整展示身形、固定服装和标志特征；左侧包含面部微距特写与毛发、皮肤、服饰的标准色值配色板；底部拆分配饰、关键道具和身份识别元素；右侧为全身比例参照、明确身高和头身比。三视图的脸型、年龄、发型、服装、体型必须完全一致。最高品质、细节丰富、可供后续视频稳定复用。`

const LOCATION_PROMPT_RULES = `场景必须绝对真空与匿名，画面和提示词中严禁出现人物、人影或角色姓名。名称至少四个字且具有唯一辨识度。提示词必须以“不能出现其他人, 无人, 纯场景,”开头，并完整包含环境类型、具体时刻与天气、空间氛围、前中后景主要特征、材质、光源方向、色彩影调、摄影机质感、焦段、光圈、景深、对焦位置、背景虚化与焦外质感；同时要求四宫格四视图：高角度航拍俯瞰、低角度仰视、侧面视角、反面视角。结尾包含 no humans, empty, landscape only。杜绝游戏 CG 感、塑料感、过度美化、错误透视、过曝和主体模糊。`

const PROP_PROMPT_RULES = `道具设定必须精准遵循剧本用途与年代，独立展示完整造型、尺寸参照、正侧背与关键局部，细腻描述材质纹理、真实光泽、磨损、污渍、雕花或制造痕迹，配色明确，商业静物摄影质感，背景干净，无人物、无手持、无粗糙瑕疵，适合后续视频稳定复用。`

export function buildAssetExtractionPrompt(input: {
  script: string
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  knownAssets?: Array<{ type: AssetType; name: string; description: string }>
  compactOutput?: boolean
}) {
  const knownAssets = input.knownAssets?.length
    ? input.knownAssets
      .slice(0, 80)
      .map((asset) => `- ${asset.type}｜${asset.name}：${asset.description.slice(0, 180)}`)
      .join('\n')
    : '暂无，按本集剧本建立稳定名称。'
  const characterRules = input.compactOutput
    ? '记录年龄、性别、体型、面部、发型、固定服装、身份气质与关键配饰；不要重复固定排版规则。'
    : `合并同一人物的全部信息，严格依据全剧年龄、外观、固定服装、身份、性格和人物弧光。${CHARACTER_PROMPT_RULES}`
  const locationRules = input.compactOutput
    ? '记录环境类型、时间天气、空间氛围、前中后景、材质、光源与色调；不得出现人物或角色姓名。'
    : `同一地点只建立一项稳定资产，不因不同镜头重复。${LOCATION_PROMPT_RULES}`
  const propRules = input.compactOutput
    ? '只记录有剧情或连续性作用的器物，写清用途、年代、尺寸、材质、配色、磨损与身份标识。'
    : `只提取有剧情、身份、动作或连续性作用的器物，普通背景杂物不单独建项。${PROP_PROMPT_RULES}`
  return `从以下已锁定分集剧本中提取拍摄必须使用的全部资产，并为每项资产整理核心视觉事实。

统一画风：
${input.compactOutput ? '此步骤只提取事实，最终统一画风由系统模板自动加入。' : buildStyleLock(input.visualStyle, input.customStylePrompt, 'image')}

提取规则：
- 角色：${characterRules}
- 场景：${locationRules}
- 道具：${propRules}
- 不臆造剧本未提供的身份事实；确需补全的可视细节要与年代、题材和剧情一致。
- tags 使用短词，最多 8 个。description 用于制作人员快速确认，prompt 必须是完整可复制的中文生图提示词。
- 只提取本集实际出现或明确被使用的资产；若与下方已有资产是同一对象，必须原样复用已有名称，不得用昵称、称谓或英文名另建重复资产。
${input.compactOutput ? '- 快速直接输出，不写分析过程。description 控制在 40-120 个中文字；每项 prompt 只写该资产独有的可视事实，控制在 40-120 个中文字；tags 最多 6 个。固定画风、版式、镜头和反向约束由系统自动补全。' : ''}

已有或前序已识别资产：
${knownAssets}

只输出 JSON，不要 Markdown：
{"assets":[{"type":"character|location|prop","name":"稳定且唯一的资产名","description":"设定摘要","tags":["标签"],"prompt":"完整提示词"}]}

【已锁定剧本】
${input.script}`
}

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  [AssetType.character]: '角色',
  [AssetType.location]: '场景',
  [AssetType.prop]: '道具',
}

const ASSET_INVENTORY_RULES: Record<AssetType, string> = {
  [AssetType.character]: '只提取本集实际出现、说话或明确参与动作的角色。记录姓名、年龄、性别、身份、体型、面部、发型、固定服装、气质和关键配饰；同一角色不得因昵称、称谓或英文名重复创建。不同角色即使职业、族裔、服装或道具相同也不得合并；未命名角色必须使用“地点或剧情身份 + 年龄层 + 职业”的稳定称谓，与已有具名角色明确隔离。',
  [AssetType.location]: '只提取本集实际发生剧情的拍摄空间。名称必须逐字复用已锁定剧本场次中的全剧唯一标准场景名，至少四个字并具有辨识度；同一物理空间不得另起简称或近义名，不同空间不得合并。描述环境类型、具体时段、天气、空间氛围、结构、前中后景、固定陈设、主要材质、光源和色调，严禁写入人物姓名、人影、人物动作或仅在单镜变化的临时状态。',
  [AssetType.prop]: '只提取预计会跨集反复出现、需要保持固定外观的核心道具。普通杯子、餐具、手机、纸张、文具、食品、零钱、包装和一次性背景小物件不建项；记录用途、年代、尺寸、材质、颜色、磨损和识别标志。',
}

export function buildAssetInventoryPrompt(input: {
  script: string
  type: AssetType
  knownAssets?: Array<{ type: AssetType; name: string; description: string }>
  storyboardEvidence?: string
}) {
  const label = ASSET_TYPE_LABELS[input.type]
  const knownAssets = (input.knownAssets || [])
    .filter((asset) => asset.type === input.type)
    .slice(-40)
    .map((asset) => `- ${asset.name}：${asset.description.slice(0, 100)}`)
    .join('\n') || '暂无。'
  const storyboardEvidence = input.storyboardEvidence?.trim()
    ? `【已确认分镜中的${label}锚点】\n${input.storyboardEvidence.trim()}`
    : `【已确认分镜中的${label}锚点】\n暂无补充锚点，以剧本为准。`

  return `你正在执行影视制片资产清点。只分析下面这一集中的【${label}】，不要提取另外两种资产。

规则：
- ${ASSET_INVENTORY_RULES[input.type]}
- 严格依据剧本，不补造未出现的人物、地点、器物或身份事实。
- 分镜已经先于资产规划完成；分镜锚点与剧本一致时，必须逐字复用其中的角色名和标准场景名，不得另起近义名称。场景资产应吸收分镜“环境锁定”中的固定空间事实，但必须删除人物、动作和临时物品状态。
- 与已有资产属于同一对象时，必须逐字复用已有名称；不确定是否同一对象时，以剧本证据为准，不要强行合并。
- description 只写可用于后续视觉设计的事实，控制在 40-160 个中文字；tags 最多 6 个短词。
- 没有该类型资产时返回空数组。不要解释、不要分析过程、不要 Markdown。

已有${label}资产：
${knownAssets}

${storyboardEvidence}

只输出严格 JSON：
{"assets":[{"type":"${input.type}","name":"稳定且唯一的资产名称","description":"视觉事实摘要","tags":["标签"]}]}

【本集剧本】
${input.script}`
}

const ASSET_CURATION_RULES: Record<AssetType, string> = {
  [AssetType.character]: '角色是核心资产。优先保留有姓名、反复出现、承担对白或关键动作，并且跨镜头需要固定外观的角色。排除纯背景人群、路人、游客，以及只闪现且不影响剧情连续性的无名人物。',
  [AssetType.location]: '场景是核心资产。保留所有实际承载剧情、需要建立稳定空间结构和光线连续性的可拍摄场景。名称必须采用已锁定剧本中的标准场景名；同一空间的同义名称归并到该标准名，但不要把物理上分离的地点或连续路线错误合成一个场景。合并后保留固定结构、陈设、材质、光源方向和色调事实，删除人物动作与临时物品状态。',
  [AssetType.prop]: '道具只保留在至少 2 个不同分集中反复出现、确实需要固定外观的项目。即使被拿取或特写，若只出现一集，也不进入资产库。排除普通杯子、餐具、手机、纸张、文具、食品、零钱、包装和背景杂物。',
}

export function buildAssetCurationPrompt(input: {
  type: AssetType
  assets: Array<{ type: AssetType; name: string; description: string; tags: string[] }>
  knownAssets?: Array<{ type: AssetType; name: string; description: string }>
  episodeAppearances?: Array<{ name: string; count: number }>
}) {
  const label = ASSET_TYPE_LABELS[input.type]
  const knownAssets = (input.knownAssets || [])
    .filter((asset) => asset.type === input.type)
    .slice(-50)
    .map((asset) => `- ${asset.name}：${asset.description.slice(0, 80)}`)
    .join('\n') || '暂无。'
  const appearanceCounts = new Map((input.episodeAppearances || []).map((item) => [item.name, item.count]))
  const candidates = input.assets.map((asset, index) => (
    `${index + 1}. ${asset.name}｜出现于 ${appearanceCounts.get(asset.name) || 1} 个分集｜${asset.description.slice(0, 180)}｜${asset.tags.join('、')}`
  )).join('\n')

  return `你是影视项目的制片主任。请筛选并归并下面这批【${label}】候选，只保留真正需要进入资产库、保持跨镜头视觉连续性的项目。

筛选标准：
- ${ASSET_CURATION_RULES[input.type]}
- 不得新增候选中不存在的资产，不得补造剧情事实。
- 同一对象的昵称、称谓、英文名或近义名称只保留一项；与已有资产相同的对象必须逐字复用已有名称。
- description 合并候选中已有的可见事实，控制在 40-180 个中文字；tags 最多 8 个。
- 没有制片价值的候选直接删除。不要输出删除理由、分析过程或 Markdown。

已有稳定${label}资产：
${knownAssets}

本批候选：
${candidates}

只输出严格 JSON：
{"assets":[{"type":"${input.type}","name":"稳定且唯一的资产名称","description":"归并后的视觉事实","tags":["标签"]}]}`
}

export function buildAssetSelectionPrompt(input: {
  type: AssetType
  assets: Array<{ type: AssetType; name: string; description: string; tags: string[] }>
  requiredNames?: string[]
  episodeAppearances?: Array<{ name: string; count: number }>
}) {
  const label = ASSET_TYPE_LABELS[input.type]
  const appearanceCounts = new Map((input.episodeAppearances || []).map((item) => [item.name, item.count]))
  const candidates = input.assets.map((asset, index) => (
    `${index + 1}. ${asset.name}｜出现于 ${appearanceCounts.get(asset.name) || 1} 个分集｜${asset.description.slice(0, 120)}`
  )).join('\n')
  const required = input.requiredNames?.length ? input.requiredNames.join('、') : '无'

  return `你是影视项目的总制片主任。请对已经初筛的【${label}】做全剧最终确认。

规则：
- ${ASSET_CURATION_RULES[input.type]}
- 不设固定数量上限，保留每一项确实需要视觉连续性的资产，同时删除重复项和制片价值不足的项目。
- selectedNames 必须逐字复制候选名称，不得改名、不得新增名称。
- 已有图片资产必须保留：${required}
- 只输出严格 JSON，不要解释、不要 Markdown。

候选清单：
${candidates}

输出格式：
{"selectedNames":["候选中的准确名称"]}`
}

export function buildSingleAssetPrompt(input: {
  asset: { type: AssetType; name: string; description: string; tags: string[] }
  visualStyle: VisualStyle
  customStylePrompt?: string | null
}) {
  const label = ASSET_TYPE_LABELS[input.asset.type]
  const productionRules = input.asset.type === AssetType.character
    ? CHARACTER_PROMPT_RULES
    : input.asset.type === AssetType.location
      ? LOCATION_PROMPT_RULES
      : PROP_PROMPT_RULES

  return `你是电影级${label}视觉设定导演。请只为下面这一项资产生成可直接用于生图模型的完整提示词。

统一画风：
${buildStyleLock(input.visualStyle, input.customStylePrompt, 'image')}

制作规则：
${productionRules}

资产事实：
- 类型：${label}
- 名称：${input.asset.name}
- 已确认设定：${input.asset.description}
- 标签：${input.asset.tags.join('、') || '无'}

要求：
- 只扩写可见、可拍摄、可执行的视觉细节，不改变名称，不杜撰身份、剧情、时代或人物关系。
- description 写成 60-260 个中文字的制作摘要；tags 最多 10 个短词。
- prompt 必须完整包含统一画风、主体细节、构图、材质、光线、色彩、镜头参数和该类型的制作规则，可独立复制生图。
- 只输出严格 JSON，不要解释、不要推理过程、不要 Markdown。

输出格式：
{"description":"完整制作摘要","tags":["标签"],"prompt":"完整中文生图提示词"}`
}

export const STORYBOARD_SYSTEM_PROMPT = '你是一位深耕电影三十余年的世界级导演和分镜师。你把已锁定剧本转换为可拍摄、可直接提交视频模型的电影级分镜，保留人物现场对白，坚持用画面讲故事，默认不使用旁白、画外音或内心独白；只有删除后会造成关键事实无法理解且该事实无法视觉化时，才保留原剧本中的最短一句，不输出解释。'

export const STORYBOARD_GLOBAL_RULES = `【所有分镜默认生效的电影级参数】
- 光影：伦勃朗光为主，关键帧叠加逆光轮廓光；室内或森林场景按需要加入丁达尔效应。
- 运镜：以克制的手持跟拍、轻微自然抖动和符合剧情的推、拉、摇、移为主，保持电影纪实感。
- 画质：电影级浅景深、8K 超高清、HDR10+；只有动作关键处才使用 120fps 慢动作。
- 写实动态：人物自然眨眼，呼吸时胸腔起伏，眼神自然流转，发丝随动作或气流飘动，衣服褶皱随肢体变化，全局物理运动真实。
- 神态表演：每镜使用“初始神态 -> 触发动作或对白 -> 可见变化”的表演链，明确视线落点，并至少描写眉眼、嘴角中的一项微表情；神态随冲突推进产生递进、掩饰、动摇或反转，相邻镜头承接上一情绪但不得无理由重复同一表情，也不得无原因突变。
- 动作物理：每个动作必须按“准备姿态 -> 重心转移 -> 主动肢体沿连续路径运动 -> 明确接触或停点 -> 身体完成缓冲 -> 稳定结束姿态”执行；同一时刻只进行一个主要动作。双脚接触地面时不得滑移，关节不得反向或超出生理活动范围，身体、衣物、头发和道具不得互相穿透。
- 接触与遮挡：人物触碰人物、道具或家具前，先写清主动方、使用哪只手、接近路径和唯一接触点；接触后保持受力关系，完成后才松开。关键手部、脚部与道具尽量保持可见；被遮挡的肢体不得在遮挡后换手、增生、消失或改变姿态。
- 镜头负荷：一个子镜头只使用一种主要摄影机运动。人物存在奔跑、跌倒、打斗、拥抱、递接物品等复杂动作时，优先中景、全身景别的固定机位或单向稳定跟拍，确保主动肢体、双脚和接触点不被裁出画面；禁止同时环绕、甩镜、急推拉或无依据变焦。
- 连续性：下一镜首帧必须从上一镜尾帧的角色站位、身体朝向、手部状态、视线、服装、发型、道具归属、场景陈设和光线开始；只有动作顺序明确写出的项目才允许变化。
- 人物身份隔离：同职业、同族裔、同款服装或相似道具不代表同一人物；只有剧本明确说明为同一人时才允许复用姓名和人物资产。未命名人物须使用包含地点、年龄层或剧情身份的稳定称谓，禁止把甲角色的伤势、经历、车辆或随身物品转移给乙角色。
- 视觉锁定：已有资产主图时，人物面容、年龄、身材和服装必须与主图一致；尚未规划资产时，严格沿用剧本已经明确的姓名、年龄、外形、服装和场景事实，后续资产规划必须反向复用本分镜标准名称。角色专属道具不得换手、转移到其他角色、漂浮、复制或无故消失；不得新增剧本之外的人物或物品。
- 时空转换：现实、回忆和梦境必须通过明确的尾帧与镜间衔接顺序转换；前一时空完全退出后才能出现后一时空，禁止两个时空的人物或陈设同时存在，禁止闪白和从瞳孔内部穿越。
- 15 秒成片：当提示词包含多个带时间段的子镜头时，严格按时间顺序依次表演和切换，不并行、不倒序；只有当前时间段指定的角色开口，其余角色只做符合剧情的反应。
- 画外音控制：默认无旁白、无画外音、无内心独白。情绪、动作、环境、转场和画面已经能表达的信息一律不配画外音；不得新增原剧本没有的画外声音。
- 禁用：无任何字幕、无任何背景音乐、无水印、无 UI 元素。保留剧本明确要求的人声、环境音和必要音效。`

export type ScriptSceneLocation = {
  name: string
  description: string
}

function normalizedScriptSceneName(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function extractScriptSceneLocations(script: string): ScriptSceneLocation[] {
  const source = script.replace(/\r\n/g, '\n')
  const pipeHeadingPattern = /^(?:#{1,3}\s*)?(?:场次|场景)[^\n｜|]{0,24}[｜|]\s*([^｜|\n]+)[｜|]\s*([^｜|\n]+)[｜|]\s*([^\n]+)$/gmu
  const bracketHeadingPattern = /^(?:#{1,3}\s*)?[【[]\s*(?:场次|场景)\s*[^】\]\n]*[】\]]\s*([^\n]+)$/gmu
  const colonHeadingPattern = /^(?:#{1,3}\s*)?(?:场次|场景)\s*[^：:\n]{0,16}[：:]\s*([^\n]+)$/gmu
  const headings = [
    ...[...source.matchAll(pipeHeadingPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[3],
      context: `${match[1].trim()}，${match[2].trim()}`,
    })),
    ...[...source.matchAll(bracketHeadingPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[1],
      context: match[1].trim(),
    })),
    ...[...source.matchAll(colonHeadingPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[1],
      context: match[1].trim(),
    })),
  ].sort((left, right) => left.index - right.index)
  const locations = new Map<string, ScriptSceneLocation>()

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    let name = heading.name
      .replace(/^[【\[]|[】\]]$/g, '')
      .replace(/[。；;]+$/g, '')
      .trim()
    if (!name) continue
    if ([...name].length < 4) name = `${name}核心场景`

    const bodyStart = heading.index + heading.raw.length
    const bodyEnd = headings[index + 1]?.index ?? source.length
    const sceneExcerpt = source.slice(bodyStart, bodyEnd)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 320)
    const description = `${heading.context}。${sceneExcerpt || '空间结构、固定陈设、材质和基础光线严格依据已锁定剧本。'}`
    const key = normalizedScriptSceneName(name)
    const current = locations.get(key)
    if (!current || description.length > current.description.length) {
      locations.set(key, { name, description })
    }
  }

  return [...locations.values()]
}

export function buildStoryboardGenerationPrompt(input: {
  episodeNumber: number
  episodeTitle: string
  script: string
  assets: Array<{ type: AssetType; name: string; description: string }>
  allAssetNames?: Array<{ type: AssetType; name: string }>
  scriptLocations?: ScriptSceneLocation[]
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  targetShotCount?: number
  segment?: {
    index: number
    total: number
    previousTail?: string
    previousShotTail?: string
    nextHead?: string
  }
}) {
  const scriptLocations = input.scriptLocations?.length
    ? input.scriptLocations
    : extractScriptSceneLocations(input.script)
  const relatedAssets = input.assets.length > 0
    ? input.assets.map((asset) => `- ${asset.type}｜${asset.name}：${asset.description}`).join('\n')
    : '- 当前处于先分镜、后资产规划流程；人物、场景和道具只能依据已锁定剧本中的明确事实，不得补造。'
  const indexedAssetNames = input.allAssetNames?.length
    ? input.allAssetNames
    : input.assets.length > 0
      ? input.assets
      : scriptLocations.map((location) => ({ type: AssetType.location, name: location.name }))
  const allAssetNames = indexedAssetNames
    .map((asset) => `${asset.type}｜${asset.name}`)
    .join('；') || '无'
  const allowedLocations = input.assets.filter((asset) => asset.type === AssetType.location)
  const locationSources = allowedLocations.length > 0 ? allowedLocations : scriptLocations
  const locationCatalog = locationSources.length > 0
    ? locationSources.map((asset) => `- ${asset.name}：${asset.description}`).join('\n')
    : '- 当前段没有解析到场次标题；只能逐字使用本段剧本明确写出的具体地点，不得临时杜撰。'
  const locationRule = allowedLocations.length > 0
    ? 'n 必须严格使用“时间｜场景资产标准名”，场景名只能逐字选自“本段允许的场景资产”，不得使用简称、近义名、临时地点或全项目其他场景；e 必须复用所选场景资产的空间结构、固定陈设、材质和基础光线。'
    : 'n 必须严格使用“时间｜剧本标准场景名”，场景名只能逐字选自“本段允许的剧本标准场景”；这是后续资产规划必须复用的唯一名称，不得使用简称、近义名或临时地点。e 必须依据剧本写清该空间的固定结构、陈设、材质和基础光线。'
  const locationCatalogTitle = allowedLocations.length > 0
    ? '【本段允许的场景资产｜唯一地点白名单】'
    : '【本段允许的剧本标准场景｜唯一地点白名单】'
  const segmentContext = input.segment
    ? `【当前处理范围】
这是本集第 ${input.segment.index}/${input.segment.total} 段。只为“本段剧本”生成镜头，前后内容仅供动作连续性参考，不得重复生成。
${input.segment.previousTail ? `前段结尾参考：${input.segment.previousTail}` : '这是本集开头。'}
${input.segment.previousShotTail ? `上一段最后一个已生成镜头的尾帧（当前首镜必须逐项承接）：${input.segment.previousShotTail}` : ''}
${input.segment.nextHead ? `后段开头参考：${input.segment.nextHead}` : '这是本集结尾。'}
`
    : ''
  const targetShotRule = input.targetShotCount
    ? `8. 本段必须生成至少 ${input.targetShotCount} 个原子镜头，允许为保留对白增加到 ${input.targetShotCount + 1} 个。按剧情节点、人物反应、视线变化和动作阶段合理拆镜，不得用重复画面或空镜凑数。`
    : '8. 优先合并连续动作和同一人物连续台词，避免为同一剧情节点生成重复反应镜头。'

  return `请把第 ${input.episodeNumber} 集《${input.episodeTitle}》拆成电影级可拍摄分镜。

【统一画风锁定】
${buildStyleLock(input.visualStyle, input.customStylePrompt, 'video')}
${segmentContext}

【不可违反】
1. 严格按剧本顺序，不删减、不调换剧情；人物在场说出的对白必须逐字保留。旁白、画外音和人物【OS】不属于强制逐字保留项，默认全部省略并改写为可见动作、表情、视线、道具反应或环境变化。只有同时满足“内容逐字来自原剧本、包含画面与现场对白都无法呈现的客观事实、删除后会造成剧情理解断裂”三个条件时，才允许保留一句最短必要画外音；情绪感叹、动作解释、气氛渲染、转场连接和画面复述一律删除。
2. 每镜承载约 70 个中文字；一个分镜最多只允许一个人物说话，多人对话必须拆镜。
3. 每镜写清时间、准确地点、人物锁定、道具锁定、环境与照明锁定、景别机位运动、首帧、严格动作顺序、动作物理、画面表演、对白配音、声音、尾帧、镜间衔接和禁止项；系统会组装为可逐项编辑的 Shotlab 式分镜字段“镜头时长、画幅比例、画面描述、景别运镜、首尾帧衔接”。${locationRule} 地点变化必须另起镜头，单镜不得混合两个物理空间。
4. 叙述必须使用剧本中的人物标准全名；已有资产时逐字复用资产名。不用“我、他、她”代替人物；对白内部原有人称不改。
4.1 同职业、同族裔、同款服装或相似道具不代表同一人物；只有剧本明确说明为同一人时才能复用人物资产。未命名人物使用包含地点、年龄层或剧情身份的稳定称谓，禁止把甲角色的伤势、经历、车辆或随身物品转移给乙角色。
5. 不新造主要资产；现场对白安排同步口型，旁白和【OS】不得让画面人物错误开口。禁止使用画外音解释角色正在做什么、重复已出现的对白、复述画面可见事实、渲染可以通过表情表现的情绪，或仅用于连接镜头。系统会在保存前自动移除擅自新增、未逐字取自剧本或不含必要客观事实的画外音。
6. 当前输出的是独立保存的原子分镜，每镜按 4-6 秒的内容密度书写，每集至少形成约 20 个分镜并覆盖 90 秒剧情。视频生成阶段由使用者选择同一集内 3-4 个相邻分镜，系统再按比例组成最长 15 秒的视频任务；严禁跨集组合。只写本镜独有内容，统一画风和通用电影参数由系统自动补齐，不要在每镜重复。
7. v 字段必须写出角色本镜的“初始神态 -> 触发动作或对白 -> 可见变化”，包含视线落点，以及眉眼或嘴角的微表情。根据剧情使用克制、戒备、试探、迟疑、错愕、压抑、讥讽、心虚、愤怒、松动等具体状态；同一角色相邻镜头要有连续而不重复的情绪递进，禁止连续多镜只写“神情冷淡”“面无表情”或同一个固定表情，禁止脱离剧情随机变脸。
7.1 每镜 g 是可直接作为下一镜首帧的精确尾帧状态，必须写清人物位置、朝向、手部、视线、关键服装道具、焦点和背景；下一镜 p 必须逐项复述上一镜 g，不得自行重置。
7.2 h 只锁定本镜出场人物，并写清全名、年龄外形、固定发型服装和相对位置；r 明确“道具只属于谁、戴在哪只手或拿在哪只手”，没有关键道具就写“无关键道具”；e、l 必须保持同一场景陈设和光源方向不跳变。
7.3 s 必须使用“先……；随后……；然后……；最后……”列出唯一执行顺序，每一步只包含一个主要动作，并给复杂动作预留准备和落稳时间；未写入 s 的换位、触碰、换手、换装、增删物品和转场一律禁止。
7.4 m 专门描述动作物理：起始姿态和重心、哪一侧肢体主动、连续运动路径、人物或物体间接触点、遮挡期间必须保持的姿态、结束时双脚/手部/道具的位置。无身体接触时也要写“人物之间无身体接触并保持最小间距”。禁止只写“动作自然流畅”。
7.5 c 每个子镜头最多一种主要摄影机运动；复杂肢体动作、人物接触或递接道具时优先中景或全身景别的固定机位或稳定单向跟拍，确保主动肢体、双脚和接触点始终在画内。每个原子镜头最多一个复杂身体动作，或最多三个不发生身体接触的轻微动作。z 除剧情专属错误外，列出易失败缺陷词：肢体融合、关节反折、多余手指、多余肢体、身体穿透、衣物穿模、脚底滑移、人物瞬移、道具漂浮、道具变形、人物复制、面容漂移、背景跳变。
${targetShotRule}

【本段相关资产】
${relatedAssets}

${locationCatalogTitle}
${locationCatalog}

【全项目资产名称索引】
${allAssetNames}

【输出约束】
只输出一行严格 JSON，不要 Markdown、解释或重复规则。每个字段只写本镜必要事实，使用短字段以加快返回：
{"shots":[{"t":"镜头标题","n":"时间｜准确地点","p":"承接上一镜尾帧状态；首镜写本段开场状态","h":"出场人物外形服装与相对站位锁定","r":"关键道具归属、佩戴或持握位置锁定","e":"场景空间与固定陈设锁定","l":"光源方向、色温与明暗锁定","c":"景别、机位与唯一运动","f":"首帧精确构图","s":"严格按先后排列的动作步骤","m":"重心、主动肢体路径、接触点、遮挡和结束姿态","v":"神态变化、视线与可见画面细节；优先替代非必要画外音","a":"人物全名：逐字现场对白；仅必要时最短画外音，否则无对白","q":"说话人声线、语气、重音与停顿；无对白则不生成配音","o":"环境声与必要音效，无背景音乐无字幕","g":"尾帧精确构图和人物状态","x":"如何从本镜尾帧自然进入下一镜","z":"剧情专属禁止项和具体负面缺陷词","d":5}]}

字段要求：t 简短；n 必含时间和地点；p/h/r/e/l/f/s/m/g/x/z 不得省略；c 对应“景别机位运动”；v 对应“画面内容”，必须包含有剧情触发依据的神态变化链与视线；a 对应“动作对白”，每镜至多一人说话，非必要旁白/画外音/【OS】必须写成“无对白”并把信息转入 v；q 只描述本镜实际声音，无对白时不得虚构配音；d 为 4-6 的整数，优先 4-5 秒，便于每 3-4 镜组合为一条 15 秒视频。shots 必须至少包含一个镜头。系统会强制校正镜间首尾帧连续性，并自动组装成完整中文分镜模板。

【本段剧本】
${input.script}`
}

export function buildStoryboardDialogueRepairPrompt(input: {
  episodeNumber: number
  script: string
  currentJson: string
  missing: Array<{ speaker: string; os: boolean; text: string }>
}) {
  return `第 ${input.episodeNumber} 集当前剧本段的分镜遗漏了以下对白或独白。请修正当前段的紧凑分镜 JSON；必要时拆出新镜头，每镜最多一人说话，不删改已有对白。保留并补全每镜“初始神态 -> 对白或动作触发 -> 可见变化”的表演链，写明视线及眉眼或嘴角微表情，相邻镜头不得无理由重复同一表情。每镜继续保留 p/h/r/e/l/c/f/s/m/v/a/q/o/g/x/z/d 全部字段。

遗漏内容：
${input.missing.map((item) => `- ${item.speaker}${item.os ? '【OS】' : ''}：${item.text}`).join('\n')}

本集剧本：
${input.script}

当前分镜 JSON：
${input.currentJson}

只输出修正后的完整紧凑 JSON，不要解释：{"shots":[{"t":"...","n":"...","p":"...","h":"...","r":"...","e":"...","l":"...","c":"...","f":"...","s":"...","m":"...","v":"...","a":"...","q":"...","o":"...","g":"...","x":"...","z":"...","d":5}]}`
}

export function buildMissingDialogueShotsPrompt(input: {
  episodeNumber: number
  script: string
  missing: Array<{ speaker: string; os: boolean; text: string }>
}) {
  return `只为第 ${input.episodeNumber} 集当前剧本段中遗漏的对白生成补充镜头，不要重写其他镜头。

硬性要求：
1. 每条遗漏对白单独生成一个镜头，a 字段必须逐字包含“人物全名：原对白”，不得概括、同义改写或省略。
2. 动作、时间和地点必须来自本段剧本；神态必须写成“初始神态 -> 遗漏对白触发 -> 可见变化”，写清视线以及眉眼或嘴角微变化，并符合对白的情绪语境；每镜只能有一个人物说话。
3. 必须提供人物、道具、环境、照明、首尾帧和禁止项，确保补充镜头插入后不改变相邻镜头的服装、站位、道具归属和场景陈设。
4. 只输出严格 JSON，不要解释：{"shots":[{"t":"镜头标题","n":"时间｜准确地点","p":"承接状态","h":"人物锁定","r":"道具锁定","e":"环境锁定","l":"照明锁定","c":"景别、机位与运动","f":"首帧","s":"动作顺序","m":"动作物理与接触约束","v":"人物动作表情与环境","a":"人物全名：逐字对白","q":"配音要求","o":"声音设计","g":"尾帧","x":"镜间衔接","z":"禁止项与负面缺陷词","d":4}]}

【必须补齐的对白】
${input.missing.map((item) => `- ${item.speaker}${item.os ? '【OS】' : ''}：${item.text}`).join('\n')}

【本段剧本】
${input.script}`
}

export function enforceAssetPrompt(input: {
  type: AssetType
  name: string
  prompt: string
  characterNames: string[]
  visualStyle: VisualStyle
  preserveName?: boolean
}) {
  let name = input.name.trim()
  let prompt = input.prompt.trim()
  const style = getVisualStylePreset(input.visualStyle)
  if (input.type === AssetType.character && !prompt.includes('人物设定图必须以白色背景身份卡呈现')) {
    prompt = `${CHARACTER_PROMPT_RULES}\n${prompt}`
  }
  if (input.type === AssetType.location && !prompt.includes('场景必须绝对真空与匿名')) {
    prompt = `${LOCATION_PROMPT_RULES}\n${prompt}`
  }
  if (input.type === AssetType.prop && !prompt.includes('道具设定必须精准遵循剧本用途与年代')) {
    prompt = `${PROP_PROMPT_RULES}\n${prompt}`
  }
  if (!prompt.includes(style.label)) prompt = `【${style.label}】${style.prompt}\n${prompt}`
  if (input.type === AssetType.location) {
    if (!input.preserveName && [...name].length < 4) name = `${name}核心场景`
    for (const characterName of input.characterNames) {
      prompt = prompt.split(characterName).join('角色')
    }
    const prefix = '不能出现其他人, 无人, 纯场景,'
    if (!prompt.startsWith(prefix)) prompt = `${prefix} ${prompt}`
    if (!/no humans/i.test(prompt)) prompt += '，no humans, empty, landscape only'
  }
  return { name, prompt }
}
