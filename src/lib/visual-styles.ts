import { AssetType, VisualStyle } from '@prisma/client'
import { z } from 'zod'

export const visualStyleSchema = z.nativeEnum(VisualStyle)

export type VisualStylePreset = {
  id: VisualStyle
  label: string
  shortLabel: string
  description: string
  swatch: [string, string, string]
  prompt: string
  videoPrompt: string
}

export const VISUAL_STYLE_PRESETS: Record<VisualStyle, VisualStylePreset> = {
  [VisualStyle.photorealistic]: {
    id: VisualStyle.photorealistic,
    label: '真人写实',
    shortLabel: '写实',
    description: '电影级真人质感，自然光与真实材质',
    swatch: ['#24423d', '#c97058', '#d8d2c7'],
    prompt: '超写实真人影视风格，可适配现代都市或国风题材。真实人物比例与皮肤纹理，电影级质感光照，自然光线，材质可信，布料褶皱自然，空间层次清晰，艺术写实，8K 高清纹理，画面具有短剧成片质感。',
    videoPrompt: '真人影视摄影风格，真实人物比例与面部，电影级自然光和材质，连续镜头中的服装、发型、肤色、场景陈设保持稳定，禁止动漫化或游戏 CG 化。',
  },
  [VisualStyle.overseas_live_action]: {
    id: VisualStyle.overseas_live_action,
    label: '海外真人短剧',
    shortLabel: '海外真人',
    description: '面向北美市场的美式真人竖屏短剧质感',
    swatch: ['#202327', '#b13b52', '#d6b36a'],
    prompt: '【海外真人短剧】面向北美与全球英语市场的美式真人短剧风格，真人实景拍摄感与商业流媒体成片质感。所有因剧情必须出现的招牌、文件、手机或电脑界面文字一律使用自然英语，不出现中文；非剧情必要不要生成文字。选角、妆发、服装、建筑、车辆、室内陈设和生活细节符合北美社会语境；人物族裔、国籍和年龄严格服从剧本与人物资产，不擅自改变。采用自然真实的欧美影视妆面，保留皮肤纹理、骨相和个体特征，避免中式古偶滤镜、韩系磨皮、AI 塑料脸和过度美化。奇幻身份词如狼族、Alpha、Luna、王族和长老只表示身份；除非剧本在当前画面明确写出变身或狼形，人物必须保持完整真人演员外观、正常人类面孔皮肤和四肢，禁止狼头人身、兽耳、长吻、全身兽毛、兽爪或四足姿态。好莱坞商业剧情片式布光，肤色准确，清晰主体分离，高对比但保留暗部细节；移动端优先的中近景与情绪特写，画面直接、成熟、有戏剧张力。不要海报排版、字幕、Logo、排行榜或 App UI。',
    videoPrompt: '所有角色对白和旁白必须使用自然美式英语；即使源剧本对白为中文，也只在成片中按语义翻译成英语，不朗读中文。角色声音按人物资产中的年龄、性别呈现、气质、职业和情绪匹配；同一角色跨分镜保持相同音色、音高范围和口音，剧本未指定时使用自然美式口音，禁止夸张刻板口音。画面中因剧情必须出现的招牌、文件、手机或电脑界面文字一律使用自然英语，不出现中文。面向北美与全球英语市场的美式真人短剧成片风格，真人演员、北美社会与生活语境、美式妆发服装和商业流媒体摄影。人物族裔、国籍、年龄与面部严格服从剧本和人物资产，不得擅自换脸或改成其他族裔；保留真实皮肤纹理与骨相，禁止 AI 塑料脸和过度磨皮。奇幻身份词如狼族、Alpha、Luna、王族和长老不改变人体外观；除非当前时间段明确写出变身或狼形，所有人物保持完整真人演员、人类面孔皮肤和正常四肢，禁止狼头人身、兽耳、长吻、全身兽毛、兽爪或四足姿态。白狼虚影只能作为与真人分离的半透明特效，不能替换角色本人。表演自然直接、情绪可读但不过度，口语节奏利落；优先使用适合移动端的中近景、情绪特写、正反打和克制手持跟拍。连续镜头中的脸型、肤色、发型、服装、声音和场景陈设保持稳定。不要字幕、海报文字、Logo、排行榜或 App UI。',
  },
  [VisualStyle.anime_2d]: {
    id: VisualStyle.anime_2d,
    label: '2D 动漫',
    shortLabel: '2D',
    description: '高质量赛璐珞与细腻城市背景',
    swatch: ['#315e91', '#ef767a', '#f4c95d'],
    prompt: '纯正 2D 高质量动漫插画，可在日系动漫与国风半厚涂之间保持统一。美形人设，现代都市二次元写实感，流畅干净线条，高质量赛璐珞上色，色彩鲜明但不过曝，背景细腻通透，8K 超清，禁止 3D 渲染和真人照片质感。',
    videoPrompt: '纯 2D 动漫影像，稳定线稿和赛璐珞上色，角色脸型、发型、服装配色与参考图逐帧一致，背景保持细腻通透，禁止转为真人或 3D 模型。',
  },
  [VisualStyle.anime_3d]: {
    id: VisualStyle.anime_3d,
    label: '半写实数字人 3D',
    shortLabel: '半写实 3D',
    description: '高精度数字人、真人面捕微表情与次世代游戏剧情 CG',
    swatch: ['#17191f', '#8f3045', '#d8b39b'],
    prompt: '高精度半写实 3D 数字人电影 CG，次世代游戏剧情过场质感。角色采用成年 7.5 至 8 头身和真实人体比例，面部保留清晰颅骨、颧骨、鼻骨、下颌线与自然起伏；五官精致，眼睛可轻度风格化但尺寸、瞳距和面中比例接近真人。采用高精度 PBR 材质，皮肤保留细腻纹理、柔和次表面散射和自然高光，发丝分束清晰，服装布料、首饰与环境材质可信。表情参考真人面部捕捉：情绪只通过眼神方向、内眉、下眼睑、嘴角、微启嘴唇和呼吸的细小变化表达，眼眶、眼球、嘴巴和脸型尺寸不随情绪改变。电影级构图、景深、轮廓光和通透层次。禁止欧美儿童 3D 动画、萌系卡通数字人、Q 版、大头圆脸、粗重夸张眉形、圆瞪大眼、张大嘴、鼓腮、玩偶比例、软塑料皮肤、橡胶质感、低多边形和表情包式表演；禁止退化为 2D 插画或真人照片。',
    videoPrompt: '高精度半写实 3D 数字人电影 CG，次世代游戏剧情过场质感。成年角色保持真实人体比例、清晰颅面骨相、自然眼睛尺寸、细腻皮肤次表面散射、高精度发丝和可信服装材质。表演严格采用真人面部捕捉式微表情：情绪只通过眼神方向、内眉、下眼睑、嘴角、微启嘴唇和呼吸的细小变化表达；眼眶、眼球、嘴巴和脸型尺寸固定，不因惊讶、愤怒、求救或喜悦发生夸张变形。动作和口型符合真实肌肉与物理规律，连续镜头中脸型、五官比例、体态、发型、服装、材质和场景布局稳定。禁止欧美儿童 3D 动画、萌系卡通数字人、Q 版、大头圆脸、粗重夸张眉形、圆瞪大眼、张大嘴、鼓腮、玩偶比例、软塑料皮肤、橡胶质感和表情包式表演；禁止变成 2D 插画或真人拍摄。',
  },
  [VisualStyle.chibi]: {
    id: VisualStyle.chibi,
    label: 'Q 版风格',
    shortLabel: 'Q 版',
    description: '大头小身、明亮配色与高辨识度造型',
    swatch: ['#f05d5e', '#ffd166', '#5bb9c9'],
    prompt: '精致 Q 版数字艺术风格，大头小身，比例可爱但身份特征清晰，明亮协调配色，低细节高辨识度，轮廓干净，材质与自然光照具有品质感，角色、道具和场景使用同一套造型语言，高清渲染。',
    videoPrompt: '精致 Q 版动画风格，大头小身比例和明亮配色保持稳定，动作清楚有节制，人物身份特征、服装、道具和场景造型逐镜一致，禁止写实成人比例。',
  },
}

const assetDirectives: Record<AssetType, string> = {
  [AssetType.character]: '白色背景人物设定板：正面、侧面、背面全身三视图，面部特写、配色板、关键配饰与身高比例参照。',
  [AssetType.location]: '电影级场景设定图：建筑与环境为画面主体，前中后景、固定陈设、光源和色调清晰，并给出焦段、光圈与景深。',
  [AssetType.prop]: '干净背景道具设定板：完整轮廓、尺寸参照、正侧背视图、材质纹理和关键局部清晰。',
}

const CONCISE_IMAGE_STYLE: Record<VisualStyle, string> = {
  [VisualStyle.photorealistic]: '【真人写实】电影级超写实，真人实景拍摄感，自然光影，真实材质反光，轻微胶片颗粒，细节清晰。',
  [VisualStyle.overseas_live_action]: '【海外真人短剧】北美市场美式真人短剧，真实演员与皮肤骨相，美式妆发服装和生活场景，商业流媒体摄影；人物族裔服从剧本与资产。狼族、Alpha、Luna、王族和长老仅是身份，未明确变身时必须是完整真人外观，禁止狼头人身、兽耳、长吻、全身兽毛或兽爪。剧情必需的招牌、文件和设备界面只用自然英语，不出现中文；不要字幕、Logo 或 App UI。',
  [VisualStyle.anime_2d]: '【2D 动漫】高质量赛璐珞与国风半厚涂融合，线条流畅，色彩鲜明，背景细腻，角色造型统一。',
  [VisualStyle.anime_3d]: '【半写实数字人 3D】高精度数字人电影 CG，次世代游戏剧情过场，成年真实比例、清晰颅面骨相、自然眼睛尺寸、PBR 皮肤和高精度发丝；真人面捕式微表情，眼眶与嘴巴尺寸固定；禁止欧美儿童 3D 动画、萌系卡通、Q 版、大头圆脸、圆瞪大眼和张大嘴。',
  [VisualStyle.chibi]: '【Q 版风格】大头小身，明亮协调配色，轮廓干净，低细节高辨识度，角色与场景造型语言统一。',
}

const CHARACTER_FACE_SHAPES = [
  '窄长鹅蛋脸，下颌线利落',
  '偏方椭圆脸，颧骨轮廓清楚',
  '心形脸，额头略宽、下巴收尖',
  '较宽长圆脸，下颌角柔和但清晰',
  '菱形脸，颧骨略高、下颌收窄',
  '短椭圆脸，面中紧凑、下巴圆中带直',
] as const

const CHARACTER_BROW_EYES = [
  '平直浓眉、狭长内双眼，眼尾微收',
  '略上挑剑眉、深眼窝杏眼',
  '柔和弧眉、眼尾微垂的长杏眼',
  '眉峰清楚、较窄丹凤眼',
  '粗直眉、双眼皮偏深、瞳距适中',
  '细长平眉、外眼角轻微上扬',
] as const

const CHARACTER_NOSE_MOUTHS = [
  '鼻梁直且鼻尖窄，薄上唇与清晰唇峰',
  '鼻根略低、鼻翼收窄，下唇稍丰',
  '高鼻梁、圆润鼻尖，嘴角自然平直',
  '鼻梁偏短、鼻头小巧，唇形饱满但克制',
  '鼻骨线条清楚、鼻尖略钝，唇线偏直',
  '鼻梁纤细、鼻尖微翘，唇峰柔和',
] as const

const CHARACTER_MICRO_MARKS = [
  '左眉尾有极淡断眉',
  '右眼下方有一颗极浅小痣',
  '鼻梁与上颊有少量淡雀斑',
  '左右嘴角高度有轻微自然差异',
  '眉间骨相与纹理略明显',
  '耳廓偏长且轮廓清晰',
] as const

function stableCharacterIdentityHash(value: string) {
  let hash = 2166136261
  for (const character of value.trim().normalize('NFKC')) {
    hash ^= character.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function buildCharacterIdentityAnchor(name: string) {
  const hash = stableCharacterIdentityHash(name)
  const face = CHARACTER_FACE_SHAPES[hash % CHARACTER_FACE_SHAPES.length]
  const eyes = CHARACTER_BROW_EYES[Math.floor(hash / 7) % CHARACTER_BROW_EYES.length]
  const noseMouth = CHARACTER_NOSE_MOUTHS[Math.floor(hash / 43) % CHARACTER_NOSE_MOUTHS.length]
  const mark = CHARACTER_MICRO_MARKS[Math.floor(hash / 257) % CHARACTER_MICRO_MARKS.length]
  return `人物差异化锚点（仅补充已确认设定未覆盖的部分，若冲突则以剧本和资产事实为准）：${face}；${eyes}；${noseMouth}；${mark}。同一角色所有视角和后续版本稳定复用这些骨相特征。`
}

export function getVisualStylePreset(style: VisualStyle) {
  return VISUAL_STYLE_PRESETS[style]
}

export function buildConciseImageStyle(
  style: VisualStyle,
  customStylePrompt?: string | null,
) {
  const custom = customStylePrompt?.trim().slice(0, 180)
  return [
    CONCISE_IMAGE_STYLE[style],
    custom ? `补充风格：${custom}` : '',
  ].filter(Boolean).join('\n')
}

export function buildStyleLock(
  style: VisualStyle,
  customStylePrompt?: string | null,
  medium: 'image' | 'video' = 'image',
) {
  const preset = getVisualStylePreset(style)
  const base = medium === 'video' ? preset.videoPrompt : preset.prompt
  return [
    `项目统一画风：${preset.label}。`,
    base,
    customStylePrompt?.trim() ? `项目补充风格规则：${customStylePrompt.trim()}` : '',
    '严格保持同一项目中人物、道具、场景的色彩体系、光照逻辑、材质表现和细节密度一致，不混用其他画风。',
  ].filter(Boolean).join('\n')
}

export function normalizeLegacyAnime3dAssetPrompt(value: string) {
  return value
    .split('\n')
    .filter((line) => !/^【3D\s*CG\s*动漫】/u.test(line.trim()))
    .join('\n')
    .replace(/高品质\s*3D\s*CG\s*动漫写真风格/gu, '高精度半写实 3D 数字人电影 CG')
    .replace(/3D\s*CG\s*动漫风格/gu, '高精度半写实 3D 数字人风格')
    .replace(/游戏过场动画级/gu, '次世代游戏剧情过场级')
    .replace(/动漫写真风格/gu, '半写实 3D 数字人电影 CG')
    .replace(/偏?圆脸/gu, '偏宽椭圆脸，成年下颌线清晰')
    .replace(/大眼睛/gu, '眼睛尺寸自然')
    .replace(/眉毛上扬/gu, '眉峰自然')
    .replace(/嘴角带笑/gu, '嘴角轻微放松')
    .replace(/表情活泼俏皮/gu, '神态灵动但表情幅度克制')
    .replace(/表情活泼/gu, '神态自然灵动，表情幅度克制')
    .replace(/嬉笑与不服/gu, '眼神带不服，面部肌肉保持克制')
    .replace(/动态扭曲/gu, '符合人体重心的受力姿态')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

export function buildStyledAssetPrompt(input: {
  asset: {
    type: AssetType
    name: string
    description: string
    prompt?: string | null
  }
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  promptOverride?: string | null
}) {
  const originalSourcePrompt = input.promptOverride?.trim()
    || input.asset.prompt?.trim()
    || input.asset.description.trim()
  const sourcePrompt = input.visualStyle === VisualStyle.anime_3d
    ? normalizeLegacyAnime3dAssetPrompt(originalSourcePrompt)
    : originalSourcePrompt
  const preset = getVisualStylePreset(input.visualStyle)
  const hasStyle = input.visualStyle === VisualStyle.anime_3d
    ? sourcePrompt.includes('【半写实数字人 3D】') || sourcePrompt.includes('【写实国漫 3D】')
    : sourcePrompt.includes(preset.label)
  const hasName = sourcePrompt.includes(input.asset.name)
  const hasLayout = input.asset.type === AssetType.character
    ? /正面[^。\n]{0,40}侧面[^。\n]{0,40}背面/u.test(sourcePrompt)
    : input.asset.type === AssetType.location
      ? /四宫格|前景[^。\n]{0,80}中景[^。\n]{0,80}背景|焦段[^。\n]{0,80}光圈[^。\n]{0,80}景深/u.test(sourcePrompt)
      : /正侧背|尺寸参照|关键局部/u.test(sourcePrompt)
  const customStyle = input.customStylePrompt?.trim()
  const characterIdentityAnchor = input.asset.type === AssetType.character
    && !sourcePrompt.includes('人物差异化锚点')
    ? buildCharacterIdentityAnchor(input.asset.name)
    : ''

  return [
    hasStyle ? '' : buildConciseImageStyle(input.visualStyle, input.customStylePrompt),
    hasStyle && customStyle && !sourcePrompt.includes(customStyle)
      ? `补充风格：${customStyle.slice(0, 180)}`
      : '',
    hasName ? '' : `资产名称：${input.asset.name}。`,
    hasLayout ? '' : assetDirectives[input.asset.type],
    characterIdentityAnchor,
    sourcePrompt,
  ].filter(Boolean).join('\n')
}

export function visualStyleOptions() {
  return Object.values(VISUAL_STYLE_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    shortLabel: preset.shortLabel,
    description: preset.description,
    swatch: preset.swatch,
  }))
}
