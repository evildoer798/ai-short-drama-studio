import { AssetType, VisualStyle } from '@prisma/client'
import {
  SCRIPT_COLD_OPEN_START,
  SCRIPT_ENDING_HOOK,
  SCRIPT_MAIN_TIMELINE_START,
} from './script-quality'
import {
  buildCharacterIdentityAnchor,
  buildConciseImageStyle,
  buildStyleLock,
  getVisualStylePreset,
} from './visual-styles'

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
  const normalize = (value: string) => {
    const normalized = value
      .replace(/[\s“”「」『』'"，。！？：；、,.!?:~～…@￥&]/gu, '')
      .replace(/^嗯+/gu, '')
      .replace(/没没(?:啊)?/gu, '没有')
    return normalized.length > 2 ? normalized.replace(/[啊呀呢吧]+$/gu, '') : normalized
  }
  const source = normalize(dialogue)
  if (source.length < 2) return false
  if (normalize(content).includes(source)) return false

  const lcsRatio = (candidate: string) => {
    let previous = new Uint16Array(candidate.length + 1)
    for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
      const current = new Uint16Array(candidate.length + 1)
      for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex++) {
        current[candidateIndex + 1] = source[sourceIndex] === candidate[candidateIndex]
          ? previous[candidateIndex] + 1
          : Math.max(previous[candidateIndex + 1], current[candidateIndex])
      }
      previous = current
    }
    return previous[candidate.length] / source.length
  }
  const bigramCoverage = (candidate: string) => {
    if (source.length < 2) return candidate.includes(source) ? 1 : 0
    const bigrams = new Set(Array.from(
      { length: source.length - 1 },
      (_value, index) => source.slice(index, index + 2),
    ))
    let matched = 0
    for (const bigram of bigrams) if (candidate.includes(bigram)) matched++
    return matched / Math.max(1, bigrams.size)
  }
  const numericFacts = dialogue.match(/(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千万]+)(?:万|岁|年|块|元)/gu) || []
  const scriptedDialogues = extractScriptDialogueLines(content).map((item) => item.text)
  const quotedDialogues = [...content.matchAll(/[“「『]([^”」』]{1,800})[”」』]/gu)]
    .map((match) => match[1].trim())
  const baseCandidates = [...scriptedDialogues, ...quotedDialogues]
  if (baseCandidates.length === 0) {
    baseCandidates.push(...content
      .split(/\r?\n|(?<=[。！？!?])/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 1_000))
  }
  const candidates = baseCandidates.flatMap((value, index) => [
    value,
    baseCandidates.slice(index, Math.min(baseCandidates.length, index + 3)).join(''),
  ])

  const meaningCovered = candidates.some((value) => {
    const candidate = normalize(value)
    if (!candidate || numericFacts.some((fact) => !value.includes(fact))) return false
    if (candidate.includes(source)) return true
    const retainedLength = Math.min(1, candidate.length / source.length)
    const lcs = lcsRatio(candidate)
    const bigrams = bigramCoverage(candidate)
    if (source.length <= 8) return lcs >= 0.75 && retainedLength >= 0.6
    if (source.length <= 20) return lcs >= 0.48 && bigrams >= 0.3 && retainedLength >= 0.4
    return lcs >= 0.45 && bigrams >= 0.28 && retainedLength >= 0.35
  })
  return !meaningCovered
}

export function extractScriptDialogueLines(content: string) {
  return content.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([\p{L}\p{N}·•.'’ _-]{1,32})(?:[（(][^）)\n]{1,40}[）)])?(【OS】)?[：:]\s*(.{1,800})$/u)
    if (!match) return []
    const speaker = match[1].trim()
    if (/^(场次|场号|时间|地点|内景|外景|画面|动作|场景|备注|音效|出场人物|登场人物|人物|角色)$/.test(speaker)) return []
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
2. 按剧情顺序提炼本章的关键事件、人物关系和信息揭示；原文对白可以改写为更自然、精炼、适合演员表演的剧本对白，允许删除语气词、口头重复和不影响剧情的修饰，但必须保留说话人、先后顺序、关键事实、情绪意图和剧情作用，并用必要动作连接。
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
5. 所有角色使用全剧标准姓名，叙述改为可见动作与现场对白，非必要不使用旁白或【OS】。小说转剧本允许口语化、合并同义句和精简过长对白，但不得改变关键事实、人物关系、事件顺序、说话人或情绪作用。
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
  return `请把对白清单中尚未被剧本覆盖的关键信息，安排到对应人物、场次和动作语境中。允许改写为更短、更自然的可表演对白，但必须保留说话人、关键事实、先后顺序、情绪意图和剧情作用。沿用现有剧本的情节与场次，并返回整合后的完整剧本。

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

const CHARACTER_PROMPT_RULES = `白色背景人物设定板：上方为正面、侧面、背面三个全身视角；左侧为面部特写与毛发、皮肤、服装标准色值；底部展示关键配饰和身份部件；右侧标注身高与头身比。各视图的脸型、年龄、发型、体型和固定服装一致。为人物建立可跨镜头复现的面部身份锚点，至少明确脸型、眉眼、鼻唇结构和一项细微识别特征；同项目角色至少在其中三项形成可见差异。`

const LOCATION_PROMPT_RULES = `电影级场景设定图：建筑与环境为画面主体，写清具体空间、年代美学、前中后景、材质纹理、时间天气、空气状态、光源方向、色彩影调和情绪反差；根据场景选择摄影机、焦段、光圈、景深、对焦点、背景虚化与焦外质感。四宫格呈现高角度航拍俯瞰、低角度仰视、侧面和背面视角。`

const PROP_PROMPT_RULES = `干净背景道具设定板：遵循剧本用途与年代，展示完整造型、尺寸参照、正侧背视图和关键局部，写清材质纹理、真实光泽、磨损或制造痕迹与固定配色。`

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
    ? '记录年龄、性别、体型、面部、发型、固定服装、身份气质与关键配饰；为每名角色提炼至少三项区别于其他角色的面部身份锚点；固定排版由系统补充。'
    : `合并同一人物的全部信息，严格依据全剧年龄、外观、固定服装、身份、性格和人物弧光。${CHARACTER_PROMPT_RULES}`
  const locationRules = input.compactOutput
    ? '记录环境类型、时间天气、空间氛围、前中后景、材质、光源与色调；只写建筑和环境事实。'
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
${input.compactOutput ? '- 快速直接输出，不写分析过程。description 控制在 40-120 个中文字；每项 prompt 只写该资产独有的可视事实，控制在 40-120 个中文字；tags 最多 6 个。固定画风、版式和镜头规则由系统自动补全。' : ''}

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
  [AssetType.character]: '只提取本集实际出现、说话或明确参与动作的角色。记录姓名、年龄、性别、身份、体型、面部、发型、固定服装、气质和关键配饰；每名角色至少记录三项可稳定复现的面部身份锚点，并与已有角色在脸型、眉眼、鼻唇或细微识别特征上形成可见差异。同一角色不得因昵称、称谓或英文名重复创建。不同角色即使职业、族裔、服装或道具相同也不得合并；未命名角色必须使用“地点或剧情身份 + 年龄层 + 职业”的稳定称谓，与已有具名角色明确隔离。',
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
- assets 数组中的每一项都必须明确保留 type:"${input.type}"，即使本次只提取一种类型也不得省略或改成其他类型。
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
- assets 数组中的每一项都必须明确保留 type:"${input.type}"，不得省略或改成其他类型。
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
  const promptLength = input.asset.type === AssetType.location
    ? '280-620 个中文字；正文为一段完整场景描述，末尾用一行“镜头参数：摄影机、焦段、光圈、景深、对焦点、背景虚化、焦外质感”收束'
    : input.asset.type === AssetType.character
      ? '220-520 个中文字'
      : '160-380 个中文字'

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
- description 写成 60-180 个中文字的制作摘要；tags 最多 10 个短词。
- prompt 控制在 ${promptLength}，完整包含统一画风、主体细节、构图、材质、光线、色彩、镜头参数和该类型制作规则，可独立复制生图。
- 不重复题目、规则说明或同义风格词；反向约束不单独成段，画质要求统一使用正向描述。
- 只输出严格 JSON，不要解释、不要推理过程、不要 Markdown。

输出格式：
{"description":"完整制作摘要","tags":["标签"],"prompt":"完整中文生图提示词"}`
}

export const STORYBOARD_DIRECTOR_SKILL_RULES = `【CINE-LOCK 导演情绪设计】
- 开始拆镜前先在内部确定每场的观众情绪、情绪视点角色、触发事件和场尾变化，再按剧情顺序拆镜；漂亮画面不得取代剧本的情感因果。
- 每镜 i 字段必须简写为“意图：揭示/羞辱/反应/升级/反转/决断/转场/钩子之一；情绪视点：人物标准全名或场景；触发：本镜唯一触发；情绪落点：本镜结束时观众应读到的可见变化”。
- 情绪视点角色必须得到画面优先级。决定性台词或动作发生时，不得连续用背影、遮挡或远景隐藏该角色；触发发生后的同镜或紧接下一镜，必须给正脸或清晰侧脸至少 1 秒可读反应，写明视线、眉眼、嘴角、呼吸或身体停顿中的具体变化。
- 说话者负责信息，倾听者负责情感。同一原子分镜可按剧本顺序包含多位现场对白说话人；任一时刻只让当前说话者同步口型，其他人物做倾听反应，并保留受影响角色的情绪落点。
- 景别随情绪强度推进：空间建立可用全景，关系冲突用双人中景或过肩，关键触发切中近景，情绪落点优先近景或特写。除有明确导演理由外，同一场景不得连续三个子镜头使用相同景别、角度和运动。
- 每镜只承担一个叙事意图、一个可见主动作和一个明确情绪落点；尾帧情绪必须交给下一镜继续，不得无原因重置。导演设计只能强化原剧本，不得改变事件、人物、对白含义或因果。`

export const STORYBOARD_SYSTEM_PROMPT = `你是一位深耕电影30余年的世界顶级导演，请将我接下来提供的【小说/书籍内容】改写成适合即梦生成动漫视频的剧本文案，要求如下：

1. 分镜结构
- 第一原则：不允许对剧本内容进行任何删改，必须保留人物之间的所有对话，充分保证剧情连贯性。
- 按剧本情节顺序编排，每一分镜对应关键剧情节点并标注清晰序号；每个分镜明确“时间（白天/夜晚/深夜）+ 场景地点 + 镜头类型（全景/近景/特写/中景）”。
- 禁止在画面叙述中使用“我、他、她、对方”等代称，必须精确写出人物全名；原对白中的人称保持原样。

2. 画面内容
- 精准呈现人物动作、表情神态和环境细节，还原回忆与现实场景的切换。动作必须合理、连续、可见，禁止“踏风而来”等不合理动作词。
- 详细分析核心场景并给出稳定、可复用的场景描述。同一标准场景在前后镜头中的空间结构、固定陈设、材质、光线和色彩不得改变。

3. 输出格式
- 内容字段只写纯中文，不使用表格。每个原子分镜约对应70个中文字的源剧本，必须在完整句子和完整动作处断镜。
- 同一原子分镜可以按剧本顺序包含多名角色的连续对话；任一时刻只让当前说话者开口，其他人物只做与剧情一致的倾听、视线和表情反应。

4. 氛围适配
- 贴合剧情氛围，通过风声、尘土、月色、药材香气等环境细节强化情绪张力；镜头转换流畅自然，符合动漫视频的视觉呈现逻辑。

5. 音画配合
- 内心独白标注【OS】；画外音默认采用年轻女声，音调中等或偏低，音色清澈柔和、冷静偏软，发音干净利落，无沙哑、无鼻音，吐字清晰，气息平稳，并根据旁白内容调整气音和语速。
- 角色台词按性别和年龄锁定音色：男主为青年男声，音调偏低、音色冷硬偏沉、字正腔圆；长辈为中年男声，音调偏低、音色沉稳偏硬、带轻微胸腔共鸣；女性为青年女声，音调中等、音色温润偏软。
- 除小说明确设定的台词外，画面角色全程不说话；台词和内心独白必须与画面节奏严格对应，不得出现口型与台词脱节。为每个实际说话角色生成稳定、可跨镜复用的配音规范。

6. AI电影级分镜提示词
- 严格遵循无字幕、无背景音乐要求。
- 光影风格：伦勃朗光为主，关键帧叠加逆光轮廓光；室内或森林场景加入丁达尔效应。
- 运镜风格：大量手持跟拍镜头，保留轻微自然抖动和强烈电影纪实感。
- 画面质感：电影级浅景深、8K超高清、HDR10+；动作关键处允许120fps慢动作捕捉。
- 写实细节：人物自然眨眼、呼吸时胸腔起伏、发丝随动作或气流飘动、眼神自然流转、衣服褶皱随肢体变化，并遵循真实物理运动。
- 禁用元素：无任何字幕、无任何背景音乐、无水印、无UI元素。

7. 输出示例
分镜1：
景别机位运动：俯拍全景，大广角快速下压。
画面内容：夜晚，古朴静谧的农家小院，院中摆放着一张灰白色粗糙石桌，桌上散落着几卷泛黄的医书，月光如霜洒在青砖地上。
动作对白：秦绾绾趴在院中的石桌上熟睡，眉头微微蹙起，神色疲惫；裴九棠端着一碗汤，轻轻走到秦绾绾身边，眼神温柔，带着几分小心翼翼。男主采用青年男声，音调偏低，音色冷硬偏沉；女性采用青年女声，音调中等，音色温润偏软。

系统内部以严格 JSON 传输上述纯中文分镜字段，不输出表格、Markdown、解释或推理过程。每3个连续原子分镜按原顺序合成为1条15秒视频提示词；每条视频提示词开头固定包含【风格基调】【本分镜人物】【场景】，随后输出【视频分镜】。人物与场景资产优先自动识别，也允许人工用“@资产名称”补充。`

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
- 不可逆状态：坠落、倒地、离场、死亡、物体脱手、门已关闭、画面切黑等完成后，后续镜头不得把人物或物体恢复到动作前状态；只有明确写出回忆、倒叙、时间倒回或重新起身等可见过程时才允许改变。每个不可逆动作只出现一次，并放在所有相关对白和反应之后。
- 人物身份隔离：同职业、同族裔、同款服装或相似道具不代表同一人物；只有剧本明确说明为同一人时才允许复用姓名和人物资产。未命名人物须使用包含地点、年龄层或剧情身份的稳定称谓，禁止把甲角色的伤势、经历、车辆或随身物品转移给乙角色。
- 人物数量与出镜：每个标准角色名只对应一名演员；一个独立分镜累计最多 4 名角色，每个时间段优先只保留 1-2 名核心人物，剧情确有必要时才允许 3-4 人。说话者、动作执行者、动作对象和承担情绪反应的人优先入镜；普通同学、路人、围观者、等待者和不参与本段剧情的人全部删除或保持画外。人物资产设定板中的正面、侧面、背面、全身和面部特写都是同一个人，不代表多名演员。每个时间段必须明确镜内角色、画外角色、人数和相对站位；仅被提及、被望向或在画外说话的角色不得自动入镜。禁止同一角色的分身、双胞胎、替身、镜像、倒影、海报或背景重复人像。
- 视觉锁定：已有资产主图时，人物面容、年龄、身材和服装必须与主图一致；尚未规划资产时，严格沿用剧本已经明确的姓名、年龄、外形、服装和场景事实，后续资产规划必须反向复用本分镜标准名称。角色专属道具不得换手、转移到其他角色、漂浮、复制或无故消失；不得新增剧本之外的人物或物品。
- 时空转换：现实、回忆和梦境必须通过明确的尾帧与镜间衔接顺序转换；前一时空完全退出后才能出现后一时空，禁止两个时空的人物或陈设同时存在，禁止闪白和从瞳孔内部穿越。
- 15 秒成片：当提示词包含多个带时间段的子镜头时，严格按时间顺序依次表演和切换，不并行、不倒序；只有当前时间段指定的角色开口，其余角色只做符合剧情的反应。
- 对白时长：按自然表演速度为对白预留时间，中文约每秒 4 个汉字，英语约每秒 2.5 个单词，并为说话人切换、停顿和反应至少预留 0.5 秒；对白放不下时必须拆镜或重新分配秒数，禁止加速念词。同一句对白在同一 15 秒段内只能出现一次。
- 声音一致：存在现场对白时写“无新增旁白、无后期配音感，保留演员现场对白”，不得同时写“无配音”“无对白”或“说话人无对白”；原剧本已有旁白、画外音和【OS】必须照常保留并与现场对白分轨呈现。完全无任何原文声音的镜头才允许写“不生成配音”。
- 原子分镜：每个独立保存的分镜只能包含一个物理地点和一个连续机位，时长 4-6 秒，约对应 70 个中文字的源剧本。同一镜可按剧本顺序包含多位说话人，换人时明确当前口型与倾听反应；地点变化、现实与回忆切换、机位切换或第二个复杂身体动作必须另起分镜。不得用斜杠标题、蒙太奇、快切或“随后切到另一地点”把多个镜头伪装成一镜。
- 画外音控制：完整保留原剧本明确存在的旁白、画外音和【OS】，并锁定声音规范；不得新增原剧本没有的画外声音。画面已经能表达的信息不额外重复配音。
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
  const compactPipeHeadingPattern = /^(?:#{1,3}\s*)?(?:场次|场景)[^\n｜|]{0,24}[｜|]\s*([^｜|\n]+)[｜|]\s*([^｜|\n]+)$/gmu
  const bracketHeadingPattern = /^(?:#{1,3}\s*)?[【[]\s*(?:场次|场景)\s*[^】\]\n]*[】\]]\s*([^\n]+)$/gmu
  const numberedBracketHeadingPattern = /^(?:#{1,3}\s*)?[【[]\s*场\s*\d+\s*[】\]]\s*([^\n]+)$/gmu
  const colonHeadingPattern = /^(?:#{1,3}\s*)?(?:场次|场景)\s*[^：:\n]{0,16}[：:]\s*([^\n]+)$/gmu
  const plainNumberedHeadingPattern = /^场\s*\d+(?:\s*[-—]\s*\d+)?\s*\n\s*([^\n]+)$/gmu
  const inlineUnderwaterLocationPattern = /^[△\s]*(深海之下|海底深处|水下深处|深海深处)[，,]/gmu
  const inlineFlashbackLocationPattern = /^[△\s]*[^\n]*(?:脑海中闪过|记忆闪回|闪回)[^\n]{0,100}((?:白色|地下|秘密|废弃)?实验室)[^\n]*$/gmu
  const inlineExteriorLocationPattern = /^[△\s]*(木屋外|庄园外|营地外|屋外|门外)[，,]/gmu
  const inlineExitToExteriorPattern = /^[△ \t]*[^\n]{0,100}?(?:走出|离开)\s*([\p{Script=Han}A-Za-z0-9·]{2,24}?(?:庄园|木屋|营地|大楼|主屋))[。；，,]/gmu
  const detectedHeadings = [
    ...[...source.matchAll(pipeHeadingPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[3],
      context: `${match[1].trim()}，${match[2].trim()}`,
    })),
    ...[...source.matchAll(compactPipeHeadingPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[2],
      context: match[1].trim(),
    })),
    ...[...source.matchAll(bracketHeadingPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[1],
      context: match[1].trim(),
    })),
    ...[...source.matchAll(numberedBracketHeadingPattern)].map((match) => {
      const parts = match[1].split(/[\/／｜|]+/u).map((part) => part.trim()).filter(Boolean)
      return {
        index: match.index || 0,
        raw: match[0],
        name: parts.at(-1) || match[1],
        context: parts.slice(0, -1).join('，') || match[1].trim(),
      }
    }),
    ...[...source.matchAll(colonHeadingPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[1],
      context: match[1].trim(),
    })),
    ...[...source.matchAll(plainNumberedHeadingPattern)].map((match) => {
      const parts = match[1].trim().split(/[\s/／｜|]+/u).filter(Boolean)
      const hasTimeAndInterior = parts.length >= 3
        && /^(?:日|夜|晨|凌晨|清晨|上午|中午|下午|黄昏|傍晚|深夜|白天|夜晚)$/u.test(parts[0])
        && /^(?:内|外|内景|外景)$/u.test(parts[1])
      return {
        index: match.index || 0,
        raw: match[0],
        name: hasTimeAndInterior ? parts.slice(2).join('') : parts.at(-1) || match[1],
        context: hasTimeAndInterior ? `${parts[0]}，${parts[1]}` : match[1].trim(),
      }
    }),
    ...[...source.matchAll(inlineUnderwaterLocationPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[1],
      context: '剧本明确由上一地点切入独立水下空间',
    })),
    ...[...source.matchAll(inlineFlashbackLocationPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: `${match[1]}（闪回）`,
      context: '回忆，内景',
    })),
    ...[...source.matchAll(inlineExteriorLocationPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: match[1],
      context: '剧本明确切入独立外景',
    })),
    ...[...source.matchAll(inlineExitToExteriorPattern)].map((match) => ({
      index: match.index || 0,
      raw: match[0],
      name: `${match[1]}外`,
      context: '剧本人物从室内明确走出建筑，切入独立外景',
    })),
  ].sort((left, right) => left.index - right.index)
  const headings = detectedHeadings.flatMap((heading, index) => {
    if (!heading.name.endsWith('（闪回）')) return [heading]
    const bodyStart = heading.index + heading.raw.length
    const bodyEnd = detectedHeadings[index + 1]?.index ?? source.length
    const flashbackBody = source.slice(bodyStart, bodyEnd)
    const returnMatch = flashbackBody.match(/^[\s△]*【闪回结束】[^\n]*$/mu)
    const previousPhysicalScene = detectedHeadings
      .slice(0, index)
      .reverse()
      .find((candidate) => !candidate.name.endsWith('（闪回）'))
    if (!returnMatch || !previousPhysicalScene) return [heading]
    return [heading, {
      index: bodyStart + (returnMatch.index || 0),
      raw: returnMatch[0],
      name: previousPhysicalScene.name,
      context: previousPhysicalScene.context,
    }]
  }).sort((left, right) => left.index - right.index)
  const locations = new Map<string, ScriptSceneLocation>()

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    let rawName = heading.name
      .replace(/^[【\[]|[】\]]$/g, '')
      .replace(/[。；;]+$/g, '')
      .trim()
    if (!rawName) continue
    if ([...rawName].length < 2) rawName = `${rawName}核心场景`

    const physicalModes = heading.context.match(/(?:内景?|外景?)/gu) || []
    const splitNames = physicalModes.length >= 2 && rawName.includes('及')
      ? rawName.split(/\s*及\s*/u).map((name) => name.trim()).filter(Boolean)
      : [rawName]
    const names = splitNames.length >= 2 ? splitNames : [rawName]

    const bodyStart = heading.index + heading.raw.length
    const bodyEnd = headings[index + 1]?.index ?? source.length
    const compactSceneBody = source.slice(bodyStart, bodyEnd)
      .replace(/\s+/g, ' ')
      .trim()
    const sceneExcerpt = compactSceneBody.length <= 640
      ? compactSceneBody
      : `${compactSceneBody.slice(0, 320)} ${compactSceneBody.slice(-320)}`
    for (const name of names) {
      const compoundContext = names.length > 1 ? `复合场次中的独立空间“${name}”` : ''
      const description = `${heading.context}${compoundContext ? `，${compoundContext}` : ''}。${sceneExcerpt || '空间结构、固定陈设、材质和基础光线严格依据已锁定剧本。'}`
      const key = normalizedScriptSceneName(name)
      const current = locations.get(key)
      if (!current) {
        locations.set(key, { name, description })
      } else if (!current.description.includes(description)) {
        locations.set(key, {
          name: current.name,
          description: `${current.description} ${description}`.slice(0, 1_400),
        })
      }
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
    ? input.assets.map((asset) => (
      `- ${asset.type}｜${asset.name}：${asset.description.replace(/\s+/gu, ' ').trim().slice(0, 180)}`
    )).join('\n')
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
    ? locationSources.map((asset) => (
      `- ${asset.name}：${asset.description.replace(/\s+/gu, ' ').trim().slice(0, 180)}`
    )).join('\n')
    : '- 当前段没有解析到场次标题；只能逐字使用本段剧本明确写出的具体地点，不得临时杜撰。'
  const segmentContext = input.segment
    ? `【当前处理范围】
这是本集第 ${input.segment.index}/${input.segment.total} 段。只为“本段剧本”生成镜头，前后内容仅供动作连续性参考，不得重复生成。
${input.segment.previousTail ? `前段结尾参考：${input.segment.previousTail}` : '这是本集开头。'}
${input.segment.previousShotTail ? `上一段最后一个已生成镜头的尾帧（当前首镜必须逐项承接）：${input.segment.previousShotTail}` : ''}
${input.segment.nextHead ? '后段另有剧本内容；当前段不得提前生成、概括或复述后段事件。' : '这是本集结尾。'}
`
    : ''
  const overseasDialogue = input.visualStyle === VisualStyle.overseas_live_action
  const dialogueOutputExample = overseasDialogue
    ? '人物全名：自然美式英语现场对白；仅必要时使用最短英语画外音，否则无对白'
    : '人物全名：完整原台词；原文内心独白标注【OS】；原文无对白时写无对白'
  const dialogueModeRule = overseasDialogue
    ? '当前为海外真人短剧：a 字段只能写自然、简洁的美式英语，完整对应源剧本对白的语义、说话人和先后顺序，禁止出现中文台词。'
    : '当前为中文剧本：a 字段必须逐字保留人物全名、原台词、旁白、画外音和【OS】，不得删词、改写、合并、串词或换说话人。'
  const locationCatalogTitle = allowedLocations.length > 0
    ? '【本段可用场景资产】'
    : '【本段剧本场景】'
  const segmentLabel = input.segment
    ? `第 ${input.segment.index}/${input.segment.total} 段`
    : '完整段落'

  return `${STORYBOARD_SYSTEM_PROMPT}

【本次生成任务】
请处理第 ${input.episodeNumber} 集《${input.episodeTitle}》的${segmentLabel}，只依据下方锁定剧本生成分镜。系统会把每 3 个连续原子分镜合成为一条 15 秒视频；不得提前生成本段之外的剧情。
${segmentContext}

【项目画风补充】
${buildStyleLock(input.visualStyle, input.customStylePrompt, 'video')}

【本段相关资产】
${relatedAssets}

${locationCatalogTitle}
${locationCatalog}

【全项目资产名称索引】
${allAssetNames}

【输出格式】
只输出一行严格 JSON，不要 Markdown、解释或推理。每个原子分镜约 4-6 秒，必须保留 i/p/h/r/e/l/c/f/s/m/v/a/q/o/g/x/z/d 字段；同一原子分镜允许多位现场对白说话人按剧本顺序依次说话。${dialogueModeRule} q 字段写每位说话人的配音规范，o 字段严格写无背景音乐、无字幕。
{"shots":[{"t":"分镜标题","n":"时间｜场景地点","i":"剧情节点与情绪","p":"首帧承接状态","h":"本分镜人物及站位","r":"道具归属","e":"固定场景描述","l":"光影","c":"景别、机位、运镜","f":"首帧画面","s":"动作顺序","m":"动作物理","v":"画面内容、表情和反应","a":"${dialogueOutputExample}","q":"角色配音规范","o":"环境声；无背景音乐、无字幕","g":"尾帧状态","x":"镜头衔接","z":"禁用元素","d":5}]}

【本段锁定剧本】
${input.script}`
}

export function buildStoryboardAtomicRepairPrompt(input: {
  episodeNumber: number
  script: string
  currentJson: string
  issues: string[]
  minimumShotCount: number
}) {
  return `第 ${input.episodeNumber} 集当前分镜中存在把多个镜头压进一镜的问题。请只做原子化重拆，不改变剧本事件顺序，不删减或改写现场对白，不新增剧本内容。

【必须修复的问题】
${input.issues.map((issue) => `- ${issue}`).join('\n')}

【原子分镜硬规则】
1. 每镜只有一个物理地点；地点变化、现实与回忆切换必须另起分镜。
2. 每镜只有一个连续机位和一种主要摄影机运动；快切、蒙太奇、多角度、跳切、从全景切特写等必须拆成多个分镜。
3. 每镜只有一个主要身体动作；同一镜可按剧本顺序包含多位对白说话人，换人时明确当前说话者口型，其他人物只保留倾听反应。
4. 每镜 4-6 秒、约对应 70 个中文字的源剧本，标题不得使用“/”“至”“→”串联多个剧情节点。
5. 每镜必须保留 i/p/h/r/e/l/c/f/s/m/v/a/q/o/g/x/z/d 全字段；i 保留导演意图、情绪视点、触发和情绪落点，相邻镜头的 p 和 f 必须承接上一镜 g。
6. 修复后以约 ${input.minimumShotCount} 镜为目标，允许上下浮动 2 镜；只修复真正不合格的镜头，禁止额外扩写、重复反应、重复建立场景或用空镜凑数。
7. 人物现场对白、旁白、画外音和【OS】均按原剧本完整保留，不得精简、改写或调换；【OS】必须显式标注。

【本段剧本】
${input.script}

【待修复分镜 JSON】
${input.currentJson}

只输出一行严格 JSON，不要解释：{"shots":[{"t":"单一动作标题","n":"时间｜唯一准确地点","i":"意图、情绪视点、触发和情绪落点","p":"承接上一镜尾帧","h":"本镜人物锁定","r":"道具锁定","e":"唯一场景锁定","l":"照明锁定","c":"单一景别机位运动","f":"首帧","s":"单一主要动作顺序","m":"动作物理","v":"当前说话者神态、其他人物倾听反应与画面","a":"按顺序写每位说话人的完整原台词、原文【OS】或无对白","q":"每位说话人或画外音的配音规范","o":"环境声与必要音效","g":"尾帧","x":"进入下一镜的衔接","z":"禁止项","d":5}]}`
}

export function buildStoryboardContinuityRepairPrompt(input: {
  episodeNumber: number
  script: string
  currentJson: string
  issues: string[]
  targetShotCount: number
}) {
  return `第 ${input.episodeNumber} 集分镜在合并为 15 秒视频段前未通过时空与声音审片。请只修复列出的问题，保持剧本事件顺序、人物身份、场景、现场对白、旁白、画外音、【OS】和因果关系，不新增剧情，不删改原文内容。

【必须修复的问题】
${input.issues.map((issue) => `- ${issue}`).join('\n')}

【连续性硬规则】
1. 逐镜建立“开场状态 -> 动作/对白 -> 尾帧状态”。下一镜必须从上一镜尾帧继续，不得重置人物位置、身体状态、手部、道具或画面明暗。
2. 坠落、倒地、离场、死亡、物体脱手、门关闭、画面切黑都是不可逆动作；完成后不得回到动作前状态。只有剧本明确写出回忆、倒叙、时间倒回或重新起身时才允许恢复。
3. 同一剧情链必须先完成对白，再执行坠落、离场、切黑等不可逆动作。不可逆动作之后只允许继续该动作或进入剧本明确的新时空。
4. 同一句对白在同一 15 秒段内只出现一次。严格按剧本顺序逐字保留说话人和完整原台词，旁白、画外音和【OS】也必须保留并显式标注；不得把后面的对白插到已经发生的坠落或切黑之后。
5. 中文对白按每秒约 4 个汉字、英语对白按每秒约 2.5 个单词核算，并为换人、停顿和反应预留至少 0.5 秒。放不下时拆成多个 4-6 秒原子镜头或重新分配秒数，禁止删词、改写或加速念词。同一原子镜头可按剧本顺序包含多位现场对白说话人。
6. 有现场对白时，q/o 统一表达“无新增旁白、无后期配音感，保留演员现场对白”，不得同时出现“无配音”“无对白”或“说话人无对白”。原剧本已有旁白、画外音和【OS】必须照常保留；完全无任何原文声音的镜头才写不生成配音。
7. 修复后保持约 ${input.targetShotCount} 个原子镜头；每镜 4-6 秒、一个地点、一个连续机位、最多一个复杂身体动作，保留 i/p/h/r/e/l/c/f/s/m/v/a/q/o/g/x/z/d 全字段。i 必须明确导演意图、情绪视点、触发和情绪落点。s 必须包含 2-4 个不重复的可见动作节拍并写清执行者、移动路径、接触或停点和稳定结束姿态；m 只保留本镜独有的重心、主动肢体、接触点与道具位置；v 写出触发前后的可见表演变化，禁止用空泛情绪词代替动作。

【本集锁定剧本】
${input.script}

【待修复分镜 JSON】
${input.currentJson}

只输出一行严格 JSON，不要解释：{"shots":[{"t":"单一剧情节拍","n":"时间｜准确地点","i":"意图、情绪视点、触发和情绪落点","p":"承接上一镜尾帧","h":"人物及站位锁定","r":"道具归属锁定","e":"静态场景摘要","l":"光线锁定","c":"单一景别机位运动","f":"首帧","s":"按先后顺序的动作","m":"动作物理","v":"表演与画面","a":"保留关键语义的自然对白或无对白","q":"说话人声线或无对白不配音","o":"现场声音与必要音效","g":"不可重置的尾帧状态","x":"进入下一镜的衔接","z":"禁止项","d":5}]}`
}

export function buildStoryboardFinalReviewPrompt(input: {
  episodeNumber: number
  script: string
  currentJson: string
  targetShotCount: number
  visualStyle: VisualStyle
  allowedLocationNames: string[]
  issues?: string[]
  verificationRound?: number
}) {
  const overseasDialogue = input.visualStyle === VisualStyle.overseas_live_action
  const hasMarkedColdOpen = input.script.includes('【倒叙冷开场】')
    && input.script.includes('【回到主线】')
  const languageRule = overseasDialogue
    ? '所有演员现场对白和必要画外音必须是自然、简洁的美式英语，完整对应源剧本语义、说话人和先后顺序；人物标准名可保留原文，但台词内容不得出现中文。美式英语允许不改变语义的同义表达、缩写和自然标点差异，不得把某一种英文译法当成唯一原文，也不得仅因省略号、逗号或同义词不同判错。'
    : '所有演员现场对白、旁白、画外音和【OS】必须逐字对应锁定剧本的说话人、先后顺序和完整内容；任何删词、改写、合并、串词、换说话人或漏掉【OS】标记都必须判错。'
  const locationCatalog = input.allowedLocationNames.length > 0
    ? input.allowedLocationNames.map((name) => `- ${name}`).join('\n')
    : '- 只能使用锁定剧本明确出现的地点'
  const issueBlock = input.issues?.length
    ? `【程序复检发现的问题｜必须纳入审片结论】\n${input.issues.map((issue) => `- ${issue}`).join('\n')}\n\n`
    : ''
  const coldOpenRule = hasMarkedColdOpen
    ? '本集剧本明确包含【倒叙冷开场】和【回到主线】：必须同时保留冷开场预演与主线后段的完整事件，不得把两者判为普通重复，不得删除任一处。两次坠落、对白或白狼闪现分别属于不同叙事时间；只需确保各自内部顺序一致，并通过明确时间转换隔开。'
    : '只有剧本明确标记的冷开场、倒叙、回忆或重放才允许事件重现。'

  const stageLabel = input.verificationRound
    ? `这是第 ${input.verificationRound} 轮修改后的再次验收。`
    : '这是初稿的首次整集复查。'

  return `第 ${input.episodeNumber} 集分镜已经完成当前版本。现在必须回到整集锁定剧本，从第一行到最后一行做一次最终审片。${stageLabel}本次调用只负责找出仍然存在的问题，不得输出分镜补丁、修改后的镜头或完整分镜，不要解释审片过程。

${issueBlock}${STORYBOARD_DIRECTOR_SKILL_RULES}

【最终审片清单】
1. 剧情顺序：先按锁定剧本建立从开场到结尾的事件索引，再逐镜核对。禁止把后段事件提前、把前段事件放到后面、遗漏因果步骤，或让冷开场之外的内容倒序。${coldOpenRule}
2. 去重：同一对白、同一反应、同一揭示、同一建立场景和同一不可逆动作不得重复生成。若剧本只出现一次，分镜也只能出现一次；不得用近义改写规避去重。
2.1 导演情绪：逐场确认观众跟随的情绪视点角色和情绪变化。决定性台词或动作出现时，受影响角色必须在同镜或紧接下一镜获得至少 1 秒正脸或清晰侧脸反应；不得让说话者占满全镜，不得连续以背影、遮挡或远景隐藏情绪视点角色。检查 i 中的意图、情绪视点、触发和情绪落点是否都能在 f/v/g 中看见。
2.2 镜头语法：景别和角度必须随建立关系、触发冲突、情绪反应、决断或钩子推进。无明确理由时，同一场景不得连续三个镜头采用相同景别、角度和运动；不得把本应属于主角的反应特写交给对手。
3. 状态连续：逐镜核对人物位置、朝向、手部、伤势、衣着、道具归属、门窗状态、画面明暗和场景陈设。坠落、倒地、离场、死亡、物体脱手、门关闭、切黑等动作完成后不得恢复旧状态；所有相关对白必须在不可逆动作前完成。
4. 场景一致：每个原子分镜只能使用一个物理地点和一个连续机位；e、n、人物站位和动作必须属于同一地点。e 只能包含时间地点、空间结构、固定陈设、材质、天气、空气状态和静态光线；只要 e 出现人物姓名、动作、表情、视线、姿态、身体接触、对白或剧情过程，一律判为 fatal，并要求把这些内容移入 s/m/v/a/g。地点变化必须另起分镜，不得把前一场景人物或陈设带入下一场景。地点名称只能使用下方白名单。
5. 对白与时长：同一原子分镜可按剧本顺序包含多位现场对白说话人，任一时刻只让当前说话者同步口型，其他人物只做倾听反应。中文按每秒约 4 个汉字、英语按每秒约 2.5 个单词，并为换人、停顿和反应预留至少 0.5 秒；放不下必须拆镜或调整为 4-6 秒，禁止删词、改写或快读。标题带“对白续镜”的相邻镜头共同承载一条长对白，必须按顺序拼接各镜 a 字段后再判断原台词是否逐字完整；断点必须位于标点、短语或完整意群边界，不得从词语中间截断。每个续镜只说自己分配到的片段，禁止把完整长句复制到每个续镜。${languageRule}
6. 声音：有现场对白时 q/o 必须写“无新增旁白、无后期配音感，保留演员现场对白”，不得出现“无配音”“无对白”或“说话人无对白”；原剧本已有旁白、画外音和【OS】必须完整保留并禁止画面人物错误对口型。完全无任何原文声音的镜头才允许不生成配音。全部镜头不要字幕、不要任何画面文字、不要背景音乐。
7. 资产与人物数量：人物、场景和关键道具名称必须复用剧本或资产标准名；不得换人、合并不同人物、改变族裔年龄、转移专属道具或新增主要资产。逐镜检查 h 中每个角色只声明一次；同一角色只能定义一次固定声音。一个独立分镜累计超过 4 名角色，或任一时间段出现与剧情无关的人物，均判为 fatal：修复时优先保留说话者、动作执行者、动作对象和情绪反应者，删除或画外化普通同学、路人、围观者和等待者；仍超过 4 人时拆镜。逐时间段检查镜内角色、画外角色、人数和站位，画面优先只保留 1-2 名核心人物。人物三视图或多视角设定板只代表同一个演员，禁止同一角色分身、替身、镜像、倒影或背景重复；仅被提及、被望向或在画外说话的角色不得自动入镜。海外真人短剧必须保持北美真人影视语境、人物固定美式声线和英语对白。
8. 结尾钩子：最后几个镜头必须完整呈现锁定剧本已有的结尾悬念、反转或钩子；不得提前结束，也不得新增剧本之外的钩子。
9. 结构：保持约 ${input.targetShotCount} 个 4-6 秒原子分镜，允许为对白自然时长上下浮动 3 镜。每镜保留 i/p/h/r/e/l/c/f/s/m/v/a/q/o/g/x/z/d 全字段，相邻镜头的 p/f 必须承接上一镜 g。禁止用空镜、重复反应或重复对白凑数。
10. 严重级别：剧情、对白、人物、场景、时序、连续性、时长不可执行和提示词矛盾均为 fatal；只有不影响剧本事实与生成正确性的镜头丰富度、构图偏好或轻微导演表现建议可标为 warning。不得把 fatal 降级为 warning。
11. 问题结构：category 只能是 plot、dialogue、character、scene、continuity、duration、prompt_conflict、directing。shotNumbers 使用下方当前镜头编号；scriptEvidence 必须引用或准确概括锁定剧本依据；repairInstruction 必须明确说明下一阶段应该怎样修改。passed 只有在 issues 为空时才能为 true。

【允许的标准场景名称】
${locationCatalog}

【本集锁定剧本】
${input.script}

【待审片的完整分镜 JSON｜镜头数组下标依次对应编号 1、2、3……】
${input.currentJson}

只输出一行严格 JSON，不要解释：{"passed":false,"issues":[{"severity":"fatal","category":"dialogue","shotNumbers":[2,3],"scriptEvidence":"锁定剧本中的对应对白与顺序","problem":"具体问题","repairInstruction":"需要执行的具体修改"}]}
完全没有问题时输出：{"passed":true,"issues":[]}`
}

export type StoryboardFinalReviewPromptIssue = {
  severity: 'fatal' | 'warning'
  category: 'plot' | 'dialogue' | 'character' | 'scene' | 'continuity' | 'duration' | 'prompt_conflict' | 'directing'
  shotNumbers: number[]
  scriptEvidence: string
  problem: string
  repairInstruction: string
}

export function buildStoryboardFinalRepairPrompt(input: {
  episodeNumber: number
  script: string
  currentJson: string
  targetShotCount: number
  visualStyle: VisualStyle
  allowedLocationNames: string[]
  issues: StoryboardFinalReviewPromptIssue[]
  repairRound: number
}) {
  const overseasDialogue = input.visualStyle === VisualStyle.overseas_live_action
  const languageRule = overseasDialogue
    ? '现场对白必须使用自然、简洁的美式英语，保持锁定剧本的语义、说话人和顺序；不得出现中文字幕或中文台词。'
    : '现场对白、旁白、画外音和【OS】必须逐字保持锁定剧本的说话人、顺序和完整内容；对白过长时只能拆镜，禁止删词、改写、串词、换说话人或丢失【OS】标记。'
  const locationCatalog = input.allowedLocationNames.length > 0
    ? input.allowedLocationNames.map((name) => `- ${name}`).join('\n')
    : '- 只能使用锁定剧本明确出现的地点'

  return `第 ${input.episodeNumber} 集正在执行第 ${input.repairRound} 轮整集分镜修复。复查阶段已经列出问题；本次调用只负责根据这些问题生成可执行的小型补丁，不得再次只做检查，也不得为了通过验收改写锁定剧本。

【必须执行的复查结果】
${JSON.stringify(input.issues)}

【修复硬规则】
1. 逐项落实 repairInstruction；剧情事实、事件顺序、人物身份、说话人、场景和因果关系必须以锁定剧本为唯一依据，不新增剧情。
2. 同一原子分镜可按剧本顺序包含多位现场对白说话人，换人时明确当前说话者口型和其他人物倾听反应。对白放不下时拆成多个 4-6 秒续镜；长对白必须在标点、短语或完整意群边界断开并按顺序分配，禁止删词、改写、从词语中间截断或复制完整台词。
3. 修复人物站位、朝向、接触状态、道具归属、运动方向和不可逆动作时，下一镜必须从上一镜尾帧继续，不得无过程换位或状态复原。
4. 每个镜头只能包含一个物理地点；地点变化必须另起分镜。场景名只能使用白名单。e 只保留时间地点、空间结构、固定陈设、材质、天气、空气状态和静态光线；删除其中所有人物动作、表情、视线、接触、对白和剧情过程，并将确属本镜的内容移入 s/m/v/a/g。${languageRule}
5. 有现场对白时保留演员现场对白；无新增旁白、无后期配音感、无字幕、无画面文字、无背景音乐。原剧本已有旁白、画外音和【OS】必须完整保留，对应音频保持开启。
6. 保持约 ${input.targetShotCount} 个原子镜头，允许为对白自然时长上下浮动 3 镜。新增镜头必须包含 i/p/h/r/e/l/c/f/s/m/v/a/q/o/g/x/z/d 全字段。每镜累计最多 4 名角色，每个画面优先只保留 1-2 名核心人物；删除或画外化无对白、无动作、无情绪作用的普通同学、路人、围观者和等待者，仍超过 4 人时拆镜。
7. 只修改复查问题涉及的镜头。replacements 只返回变化字段；insertions 只补遗漏内容；remove 只删重复或剧本外镜头；order 只用于纠正事件顺序。不得返回空补丁或把原内容原样写回。
8. 本次修复结果必须交给下一阶段重新验收，passed 固定写 false，issues 固定为空。

【允许的标准场景名称】
${locationCatalog}

【本集锁定剧本】
${input.script}

【当前完整分镜 JSON｜镜头编号从 1 开始】
${input.currentJson}

只输出一行严格 JSON，不要解释：{"passed":false,"issues":[],"order":[],"remove":[],"replacements":[{"shotNumber":2,"shot":{"a":"修正后的现场对白","s":"修正后的连续动作","g":"修正后的尾帧状态"}}],"insertions":[]}`
}

export function buildStoryboardDialogueRepairPrompt(input: {
  episodeNumber: number
  script: string
  currentJson: string
  missing: Array<{ speaker: string; os: boolean; text: string }>
}) {
  return `第 ${input.episodeNumber} 集当前剧本段的分镜遗漏了以下对白或独白。请修正当前段的紧凑分镜 JSON；同一原子分镜可按剧本顺序包含多位现场对白说话人，换人时明确当前口型和倾听反应。逐字保留说话人、顺序和完整原台词；对白过长时只能在完整意群边界拆成续镜，禁止删词或改写。旁白、画外音和【OS】必须完整保留，【OS】显式标注。保留并补全每镜“初始神态 -> 对白或动作触发 -> 可见变化”的表演链，写明视线及眉眼或嘴角微表情，相邻镜头不得无理由重复同一表情。每镜继续保留 i/p/h/r/e/l/c/f/s/m/v/a/q/o/g/x/z/d 全部字段。

遗漏内容：
${input.missing.map((item) => `- ${item.speaker}${item.os ? '【OS】' : ''}：${item.text}`).join('\n')}

本集剧本：
${input.script}

当前分镜 JSON：
${input.currentJson}

只输出修正后的完整紧凑 JSON，不要解释：{"shots":[{"t":"...","n":"...","i":"意图、情绪视点、触发和情绪落点","p":"...","h":"...","r":"...","e":"...","l":"...","c":"...","f":"...","s":"...","m":"...","v":"...","a":"...","q":"...","o":"...","g":"...","x":"...","z":"...","d":5}]}`
}

export function buildMissingDialogueShotsPrompt(input: {
  episodeNumber: number
  script: string
  missing: Array<{ speaker: string; os: boolean; text: string }>
}) {
  return `只为第 ${input.episodeNumber} 集当前剧本段中遗漏的对白生成补充镜头，不要重写其他镜头。

硬性要求：
1. a 字段必须逐句写“人物全名：完整原台词”，逐字保留原对白的说话人、顺序和全部内容；旁白、画外音和【OS】也必须完整补齐，【OS】显式标注。同一原子分镜可按剧本顺序包含多位现场对白说话人；过长对白只能在完整意群边界拆成续镜，禁止删词或改写。
2. 动作、时间和地点必须来自本段剧本；神态必须写成“初始神态 -> 对白触发 -> 可见变化”，写清当前说话者口型、其他人物的倾听反应、视线以及眉眼或嘴角微变化。
3. 必须提供人物、道具、环境、照明、首尾帧和禁止项，确保补充镜头插入后不改变相邻镜头的服装、站位、道具归属和场景陈设。
4. 只输出严格 JSON，不要解释：{"shots":[{"t":"镜头标题","n":"时间｜准确地点","i":"意图、情绪视点、触发和情绪落点","p":"承接状态","h":"人物锁定","r":"道具锁定","e":"环境锁定","l":"照明锁定","c":"景别、机位与运动","f":"首帧","s":"动作顺序","m":"动作物理与接触约束","v":"人物动作表情与环境","a":"人物全名：保留关键语义的自然对白","q":"配音要求","o":"声音设计","g":"尾帧","x":"镜间衔接","z":"禁止项与负面缺陷词","d":4}]}

【必须补齐的对白】
${input.missing.map((item) => `- ${item.speaker}${item.os ? '【OS】' : ''}：${item.text}`).join('\n')}

【本段剧本】
${input.script}`
}

function truncatePromptAtBoundary(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  const slice = normalized.slice(0, maxLength)
  const boundaries = ['。', '；', '，', ',', '、'].map((mark) => slice.lastIndexOf(mark))
  const boundary = Math.max(...boundaries)
  return `${(boundary >= Math.floor(maxLength * 0.6) ? slice.slice(0, boundary + 1) : slice).trim()}。`
}

function compactAssetPromptFacts(value: string, maxLength: number, type: AssetType) {
  const normalized = value
    .replace(/(镜头参数\s*[:：])/gu, '\n$1')
    .replace(/\n{2,}/g, '\n')
    .trim()
  const seen = new Set<string>()
  const segments = normalized
    .split(/(?<=[。！？；\n])/u)
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => {
      if (!segment) return false
      const key = segment.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  if (type !== AssetType.location) {
    return truncatePromptAtBoundary(segments.join(''), maxLength)
  }

  const cameraPattern = /镜头参数|摄影机|焦段|光圈|景深|对焦|背景虚化|焦外/u
  const camera = segments.filter((segment) => cameraPattern.test(segment)).join('')
  const visual = segments.filter((segment) => !cameraPattern.test(segment)).join('')
  const cameraBudget = camera ? Math.min(190, Math.floor(maxLength * 0.34)) : 0
  const visualBudget = Math.max(80, maxLength - cameraBudget - (camera ? 1 : 0))
  return [
    truncatePromptAtBoundary(visual, visualBudget),
    camera ? truncatePromptAtBoundary(camera, cameraBudget) : '',
  ].filter(Boolean).join('\n')
}

export function enforceAssetPrompt(input: {
  type: AssetType
  name: string
  prompt: string
  characterNames: string[]
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  preserveName?: boolean
}) {
  let name = input.name.trim()
  let prompt = input.prompt.trim()
  const style = getVisualStylePreset(input.visualStyle)
  if (input.type === AssetType.location) {
    if (!input.preserveName && [...name].length < 4) name = `${name}核心场景`
    for (const characterName of input.characterNames) {
      prompt = prompt.split(characterName).join('')
    }
  }

  prompt = prompt
    .replace(style.prompt, '')
    .replace(CHARACTER_PROMPT_RULES, '')
    .replace(LOCATION_PROMPT_RULES, '')
    .replace(PROP_PROMPT_RULES, '')
    .replace(/【(?:真人写实|2D\s*动漫|3D\s*CG\s*动漫|Q\s*版风格)】/giu, '')
    .replace(/不能出现其他人\s*[,，]\s*无人\s*[,，]\s*纯场景\s*[,，]?/giu, '')
    .replace(/no\s+humans\s*[,，]?\s*empty\s*[,，]?\s*landscape\s+only[。.]?/giu, '')
    .replace(/(?:严禁|禁止|不得|不能|不要|杜绝|避免)[^。！？；\n]+[。！？；]?/gu, '')
    .replace(/【(?:最终场景图片提示词|镜头参数摘要)】/gu, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:人物差异化锚点|人物设定图必须|场景必须绝对|提示词必须|名称至少|道具设定必须|项目统一画风|统一画风|资产类型|创作内容)/u.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const layoutRule = input.type === AssetType.character
    ? CHARACTER_PROMPT_RULES
    : input.type === AssetType.location
      ? LOCATION_PROMPT_RULES
      : PROP_PROMPT_RULES
  const maxLength = input.type === AssetType.location ? 820 : input.type === AssetType.character ? 720 : 560
  const styleLock = buildConciseImageStyle(input.visualStyle, input.customStylePrompt)
  const characterIdentityAnchor = input.type === AssetType.character
    ? buildCharacterIdentityAnchor(name)
    : ''
  const quality = '构图准确，主体清晰，透视自然，高光与暗部保留细节。'
  const fixedLength = styleLock.length + layoutRule.length + characterIdentityAnchor.length
    + quality.length + name.length + 20
  const facts = compactAssetPromptFacts(prompt, Math.max(120, maxLength - fixedLength), input.type)
  const finalPrompt = [
    styleLock,
    `资产名称：${name}。`,
    layoutRule,
    characterIdentityAnchor,
    facts,
    quality,
  ].filter(Boolean).join('\n')

  return { name, prompt: finalPrompt.slice(0, maxLength) }
}
