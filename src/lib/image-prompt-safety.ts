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

export function prepareAssetImagePrompt(input: AssetImagePromptInput): PreparedAssetImagePrompt {
  const source = input.prompt.replace(/\r\n?/g, '\n').trim()
  if (!containsImagePolicyRisk(source)) {
    return { prompt: source, adjusted: false, removedSegments: 0 }
  }

  const segments = source.split(/(?<=[。！？；\n])/u)
  const retained: string[] = []
  let removedSegments = 0

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
