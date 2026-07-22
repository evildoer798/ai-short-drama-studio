type AssetImagePromptInput = {
  prompt: string
  assetName: string
  assetType: string
}

type PreparedAssetImagePrompt = {
  prompt: string
  adjusted: boolean
  removedSegments: number
}

const POLICY_RISK_PATTERN = /血泊|血液|流血|渗血|血迹|伤口|重伤|受伤|伤势|骨折|断肢|内脏|扭曲变形|殴打|击打|警棍|暴力|车祸|事故现场|死亡|尸体|持枪|持刀|枪械|香烟|烟草|一支烟|叼着.{0,8}烟|吸烟|烟头|blood|gore|wound|injur(?:y|ed)|weapon|gun|knife|violence|beating|corpse|cigarette|smok(?:e|ing)|nudity|sexual/iu

function assetKindLabel(assetType: string) {
  if (assetType === 'location') return '场景'
  if (assetType === 'prop') return '道具'
  return '角色'
}

export function containsImagePolicyRisk(prompt: string) {
  return POLICY_RISK_PATTERN.test(prompt)
}

function normalizeLocationPrompt(source: string) {
  let removedSegments = 0
  const lines = source.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return ['']
    if (
      /场景必须绝对真空与匿名/u.test(trimmed)
      || /提示词必须以[“"]?不能出现其他人/u.test(trimmed)
      || /名称至少四个字且具有唯一辨识度/u.test(trimmed)
    ) {
      removedSegments += 1
      return []
    }
    return [line]
  })

  const prompt = lines.join('\n')
    .replace(/不能出现其他人\s*[,，]\s*无人\s*[,，]\s*纯场景\s*[,，]?/giu, '空置环境，纯场景，')
    .replace(/no\s+humans\s*[,，]\s*empty\s*[,，]\s*landscape\s+only/giu, 'empty environment, landscape composition')
    .replace(/画面(?:和提示词中)?严禁出现人物、人影或角色姓名[。；]?/gu, '画面保持空置环境。')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    prompt,
    removedSegments,
    adjusted: prompt !== source || removedSegments > 0,
  }
}

function compactPositivePrompt(value: string, limit = 3600) {
  const seen = new Set<string>()
  const lines = value.split('\n').flatMap((line) => {
    const cleaned = line
      .replace(/(?:严禁|禁止|不得|不能|不要|杜绝)[^。！？；\n]+[。！？；]?/gu, '')
      .replace(/no\s+humans\s*[,，]?/giu, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned || cleaned === '创作内容：') return []
    const key = cleaned.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
    if (!key || seen.has(key)) return []
    seen.add(key)
    return [cleaned]
  })
  const joined = lines.join('\n')
  if (joined.length <= limit) return joined
  const head = joined.slice(0, 700)
  const tail = joined.slice(-(limit - head.length - 2))
  return `${head}\n${tail}`
}

export function prepareAssetImagePrompt(input: AssetImagePromptInput): PreparedAssetImagePrompt {
  const source = input.prompt.replace(/\r\n?/g, '\n').trim()
  const normalized = input.assetType === 'location'
    ? normalizeLocationPrompt(source)
    : { prompt: source, adjusted: false, removedSegments: 0 }
  if (!containsImagePolicyRisk(normalized.prompt)) {
    return normalized
  }

  const segments = normalized.prompt.split(/(?<=[。！？；\n])/u)
  const retained: string[] = []
  let removedSegments = normalized.removedSegments

  for (const segment of segments) {
    if (POLICY_RISK_PATTERN.test(segment)) {
      removedSegments += 1
      continue
    }
    retained.push(segment)
  }

  const stableDescription = retained.join('').replace(/\n{3,}/g, '\n\n').trim()
  const kind = assetKindLabel(input.assetType)
  const identityFallback = `资产名称：${input.assetName}。生成可长期复用的${kind}标准设定，保持项目既定画风、外观、服装、材质、配色、比例和职业特征。`
  const safeIdentity = stableDescription
    ? `${stableDescription}${stableDescription.length < 120 ? `\n${identityFallback}` : ''}`
    : identityFallback

  return {
    prompt: [
      `生成适合全年龄影视制作的${kind}资产设定图。仅展示常态设计，不表现剧情事件或临时状态。`,
      safeIdentity,
      '画面保持专业、克制、完整且可复用，主体身份清晰，符合项目统一视觉风格。',
    ].join('\n\n'),
    adjusted: true,
    removedSegments,
  }
}

export function prepareImagePolicyRetryPrompt(input: AssetImagePromptInput) {
  const prepared = prepareAssetImagePrompt(input)
  const kind = assetKindLabel(input.assetType)
  const positiveContent = compactPositivePrompt(prepared.prompt)
  const composition = input.assetType === 'location'
    ? '画面为空置环境，只呈现建筑、道路、自然环境、家具、材质与灯光等场景要素。'
    : input.assetType === 'prop'
      ? '画面集中展示道具本体、材质、结构、比例与使用痕迹。'
      : '画面集中展示角色固定外观、发型、服装、比例与身份特征。'

  return [
    `生成电影级${kind}资产设定图。`,
    `资产名称：${input.assetName}。`,
    composition,
    positiveContent,
    '保持项目既定写实程度、色彩、光线和材质表现，构图清楚，细节自然。',
  ].filter(Boolean).join('\n\n').slice(0, 4200)
}
