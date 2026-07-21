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
    label: '3D CG 动漫',
    shortLabel: '3D CG',
    description: '高品质游戏角色与电影级三维渲染',
    swatch: ['#27364a', '#4fa7a0', '#b8a6d9'],
    prompt: '高品质 3D CG 动漫写真风格，游戏过场动画级角色与场景，精细三维渲染，真实质感光照与自然光线，完整材质和发丝细节，全身比例优美，数字艺术质感，可适配古风或现代题材，画面宁静而有电影冲击力，8K 高清。',
    videoPrompt: '高品质 3D CG 游戏过场动画风格，稳定角色模型、材质、发丝和服装，物理光照自然，镜头间模型比例与场景布局一致，禁止退化为 2D 插画或真人拍摄。',
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
  [AssetType.character]: '输出可用于后续多镜头复用的角色形象。面部身份、发型、体型、服装和核心配饰必须明确且可稳定复现；主体完整、无遮挡、无水印，除非原始要求中明确指定，否则不要添加文字。',
  [AssetType.location]: '输出可用于短剧分镜的场景设定图。建筑结构、空间布局、光源方向、主色和关键陈设必须清晰；默认不出现人物，除非原始要求明确需要。',
  [AssetType.prop]: '输出可用于短剧镜头的道具设定图。轮廓、材质、颜色、尺寸感和关键识别细节必须明确；主体完整，背景简洁，避免无关物体。',
}

export function getVisualStylePreset(style: VisualStyle) {
  return VISUAL_STYLE_PRESETS[style]
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
  const sourcePrompt = input.promptOverride?.trim()
    || input.asset.prompt?.trim()
    || input.asset.description.trim()

  return [
    buildStyleLock(input.visualStyle, input.customStylePrompt, 'image'),
    `资产类型：${input.asset.type}。资产名称：${input.asset.name}。`,
    assetDirectives[input.asset.type],
    '创作内容：',
    sourcePrompt,
  ].join('\n\n')
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
