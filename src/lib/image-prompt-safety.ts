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

const POLICY_RISK_PATTERN = /血泊|血液|流血|渗血|血迹|伤口|重伤|受伤|伤势|骨折|断肢|内脏|扭曲变形|殴打|击打|警棍|暴力|车祸|事故现场|死亡|尸体|持枪|持刀|枪械|香烟|烟草|一支烟|叼着.{0,8}烟|吸烟|烟头|酒柜|酒瓶|酒杯|红酒|白酒|啤酒|香槟|威士忌|烈酒|酒精|壁炉|假火|火光|火焰|明火|燃烧|火灾|blood|gore|wound|injur(?:y|ed)|weapon|gun|knife|violence|beating|corpse|cigarette|smok(?:e|ing)|nudity|sexual|alcohol|whisk(?:e)?y|wine|beer|champagne|fireplace|flame|burning/iu

function neutralizeProviderSensitiveTerms(value: string) {
  return value
    .replace(/酒柜内酒瓶半透明/gu, '深色装饰陈列柜带半透明玻璃门')
    .replace(/酒柜/gu, '深色玻璃陈列柜')
    .replace(/酒瓶/gu, '装饰玻璃瓶')
    .replace(/酒杯/gu, '透明玻璃杯')
    .replace(/红酒|白酒|啤酒|香槟|威士忌|烈酒|酒精饮品?/gu, '深色瓶装饮品')
    .replace(/壁炉假火|壁炉|假火|火光|火焰|明火|燃烧|火灾/gu, '墙面暖色装饰灯光')
    .replace(/\balcohol(?:ic)?\b|\bwhisk(?:e)?y\b|\bwine\b|\bbeer\b|\bchampagne\b/giu, 'bottled beverage')
    .replace(/\bfireplace\b|\bflame\b|\bburning\b/giu, 'warm decorative lighting')
}

function creativePromptSource(value: string) {
  const marker = '创作内容：'
  const markerIndex = value.lastIndexOf(marker)
  return markerIndex >= 0 ? value.slice(markerIndex + marker.length).trim() : value
}

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
    .replace(/不能出现其他人\s*[,，]\s*无人\s*[,，]\s*纯场景\s*[,，]?/giu, '建筑与环境为画面主体，电影场景构图，')
    .replace(/no\s+humans\s*[,，]\s*empty\s*[,，]\s*landscape\s+only/giu, '')
    .replace(/画面(?:和提示词中)?严禁出现人物、人影或角色姓名[。；]?/gu, '建筑与环境为画面主体。')
    .replace(/默认不出现人物，除非原始要求明确需要[。；]?/gu, '建筑与环境为画面主体。')
    .replace(/(?:严禁|禁止|不得|不能|不要|杜绝)[^。！？；\n]+[。！？；]?/gu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    prompt,
    removedSegments,
    adjusted: prompt !== source || removedSegments > 0,
  }
}

function compactPositivePrompt(value: string, limit = 1100) {
  const seen = new Set<string>()
  const lines = value.split('\n').flatMap((line) => {
    const cleaned = line
      .replace(/(?:严禁|禁止|不得|不能|不要|杜绝)[^。！？；\n]+[。！？；]?/gu, '')
      .replace(/no\s+humans\s*[,，]?/giu, '')
      .replace(/empty\s+environment\s*[,，]?\s*(?:landscape\s+composition)?/giu, '')
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
  return joined.slice(0, limit).replace(/[，,：:\s]+$/u, '').trim()
}

export function prepareAssetImagePrompt(input: AssetImagePromptInput): PreparedAssetImagePrompt {
  const source = input.prompt.replace(/\r\n?/g, '\n').trim()
  const neutralizedSource = neutralizeProviderSensitiveTerms(source)
  const normalizedBase = input.assetType === 'location'
    ? normalizeLocationPrompt(neutralizedSource)
    : { prompt: neutralizedSource, adjusted: false, removedSegments: 0 }
  const normalized = {
    ...normalizedBase,
    adjusted: normalizedBase.adjusted || neutralizedSource !== source,
  }
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
  const prepared = prepareAssetImagePrompt({
    ...input,
    prompt: creativePromptSource(input.prompt),
  })
  const kind = assetKindLabel(input.assetType)
  const positiveContent = compactPositivePrompt(prepared.prompt, 1050)
  const composition = input.assetType === 'location'
    ? '建筑、道路、自然环境、家具、材质与灯光构成完整画面，建筑环境是唯一视觉主体。'
    : input.assetType === 'prop'
      ? '画面集中展示道具本体、材质、结构、比例与使用痕迹。'
      : '画面集中展示角色固定外观、发型、服装、比例与身份特征。'

  return [
    `生成电影级${kind}资产设定图。`,
    `资产名称：${input.assetName}。`,
    composition,
    positiveContent,
    '保持项目既定写实程度、色彩、光线和材质表现，构图清楚，细节自然。',
  ].filter(Boolean).join('\n\n').slice(0, 1400)
}

export function prepareImagePolicyFallbackPrompt(input: AssetImagePromptInput) {
  const kind = assetKindLabel(input.assetType)
  let safeName = neutralizeProviderSensitiveTerms(input.assetName)
  for (let pass = 0; pass < 8; pass++) {
    const next = safeName.replace(POLICY_RISK_PATTERN, '')
    if (next === safeName) break
    safeName = next
  }
  safeName = safeName.trim() || `未命名${kind}`
  const composition = input.assetType === 'location'
    ? '电影级写实场景设定图。根据名称和项目世界观设计建筑或自然环境，真实材质，自然光影，清晰空间结构，四宫格呈现航拍、低角度、侧面和背面视角。'
    : input.assetType === 'prop'
      ? '电影级写实道具设定，干净背景，清楚呈现材质、结构与比例。'
      : '电影级写实角色设定，白色背景，清楚呈现正面、侧面、背面、面部与服装细节。'

  return [
    `${kind}名称：${safeName}。`,
    composition,
    '自然电影光线，真实材质，清晰构图，细节完整，适合作为短剧制作参考。',
  ].filter(Boolean).join('\n').slice(0, 900)
}
