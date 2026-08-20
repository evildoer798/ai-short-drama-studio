import type { DirectorEditableStage } from './director-system'

type StageContext = {
  productionName: string
  project: { name: string; visualStyle: string; customStylePrompt: string | null }
  episode: { title: string; content: string } | null
  sourceSnapshot: unknown
  previousOutputs: Partial<Record<DirectorEditableStage, unknown>>
  feedback?: string
}

export const DIRECTOR_SKILL_VERSIONS = {
  acting: { name: 'ACTING', version: '2026-08-12' },
  lira: { name: 'LIRA', version: '2026-08-12' },
  cinedance: { name: 'CINEDANCE HIGGSFIELD', version: '2026-08-12' },
} as const

const actingSystem = `你是 ACTING 表演导演系统。你的职责只有角色如何行动、反应和说话，不得把摄影、灯光、服装或画面风格混入表演层。
为每个角色建立 CharacterActingProfile 与 VoiceProfile；为每个可拍摄镜头建立 ShotPerformance 与 1-8 个 PerformanceBeat。
核心规则：目标必须是指向对象的行动动词，而不是情绪状态；情绪来自目标受阻。每个节拍包含触发、策略、可见行为、倾听反应、视线、身体与声音行为。潜台词不可直接表演。声音身份默认锁定。
格式硬约束：signatureTics 与 stressTics 的每一项都必须是 {"behavior":"可见行为","trigger":"触发条件"} 对象，绝对不能返回字符串数组；没有习惯动作时返回 []。
最外层必须直接是 JSON 对象，禁止用数组、result/output/data 包裹。只返回一个符合指定字段的 JSON 对象，不要解释，不要 markdown。`

const liraSystem = `你是 LIRA 图像与资产一致性导演系统。你只负责角色身份/状态资产、场景、道具、视觉风格和关键帧，不负责动态镜头。
把“同一角色的不同状态”建成独立 stateId，但每个状态必须共享稳定 identityAnchors；身份一致依靠选定参考图与 Soul ID，而不是仅靠文字。
模型路由必须遵守：角色生成 Soul 2.0/AI Cast，含角色电影帧与场景 Soul Cinema，成片编辑先 NBP，Seedream 4.5 只做纹理修复，GPT Image 2 只作为最后的局部修复或场景反打。编辑必须最小 CHANGE、穷举 PRESERVE。道具可用 NBP/GPT Image 2。
生成提示词用紧凑自然英文，不堆关键词；画幅和分辨率只作为参数，不写进提示词；优先正向描述；写具体光源、材料和来源明确的 60/30/10 色板。关键帧必须绑定角色状态、道具状态、场景和真实参考素材。
只返回一个符合指定字段的 JSON 对象，不要解释，不要 markdown。`

const cinedanceSystem = `你是 CINEDANCE 动态镜头导演系统。你在已确认的 ACTING 表演与 LIRA 资产真相上，设计首帧、空间、视线、镜头、动作时序、物理、灯光、声音和连续性。
每个镜头是密封的当前镜头文档，不泄漏场次号、上一镜摘要或未使用标签。首帧先于运动；明确人物在画面左/右/前景/中景/背景、身体朝向、视线和道具手位。
镜头使用可观察结果控制：从 8°/18°/29°/47°/84°/107°/135° 对角视场角中选一个，写物理距离、视觉结果和防漂移锁；不同内容类型需要换镜时只能硬切。手持写操作员呼吸、重量转移和人类修正。
动作按时间块编排且物理可行；明确重力、质量、惯性、摩擦、接触和跟随。灯光必须写来源、方向、机位相对光源、曝光优先级。台词只说剧本引号中的原句，无字幕、无临时加词。
连续性账本同时记录角色状态、道具持有/位置/损耗、银幕方向、视线、光向和空间地标。generationPrompt 用英文，按 SCENE CONTEXT、ACTIVE REFERENCES、FIRST FRAME AND SPATIAL BLOCKING、OPTICS、CAMERA、ACTION TIMING、PHYSICS、LIGHTING、AUDIO 组织。
只返回一个符合指定字段的 JSON 对象，不要解释，不要 markdown。`

export function directorStageJsonShape(stage: DirectorEditableStage) {
  if (stage === 'acting') return `{
  "summary":"", "characterProfiles":[{"assetId":"","assetName":"","masterPrompt":"","physicality":"","psychologicalEngine":"","vocalBehavior":"","signatureTics":[{"behavior":"","trigger":""}],"stressTics":[],"concealmentBehavior":null,"facialMask":null,"maskCrackTrigger":null,"pressureTransformation":null,"gait":"","eyeLife":"","softeningTarget":null}],
  "voiceProfiles":[{"assetId":"","assetName":"","prompt":"","ageDescriptor":"","originAccent":"","timbreRegister":"","paceDelivery":"","pressureShift":"","locked":true}],
  "shotPerformances":[{"shotKey":"shot-1","shotTitle":"","assetId":"","assetName":"","objective":"","obstacle":"","stakes":"","subtext":"","business":"","statusIn":"","statusOut":"","proximityIn":"","proximityOut":"","speaks":false,"beats":[{"order":1,"startSeconds":0,"endSeconds":4,"trigger":"","tactic":"","visibleBehavior":"","reaction":"","gaze":"","posture":"","tempo":"","voiceDelivery":"","entryState":"","exitState":""}]}],
  "userDecisions":[] }`
  if (stage === 'lira') return `{
  "summary":"", "styleBible":{"visualRegister":"","lightingRule":"","materialRule":"","paletteRule":"","imageEditOrder":["nbp","seedream-4.5","gpt-image-2"]},
  "characterStates":[{"stateId":"","assetId":"","assetName":"","stateName":"","identityAnchors":["",""],"wardrobe":"","hairMakeup":"","bodyCondition":"","wearAndContinuity":"","imageModelRoute":"soul-2","soulIdRequired":true,"prompt":"English prompt","references":[]}],
  "locations":[{"assetId":"","assetName":"","geography":"","landmarks":[""],"materials":[""],"lightingSource":"","palette":{"dominant":"","secondary":"","accent":""},"prompt":"English prompt","references":[]}],
  "props":[], "keyframes":[{"shotKey":"shot-1","shotTitle":"","purpose":"","characterStateIds":[],"propStateIds":[],"locationAssetId":null,"firstFramePrompt":"English prompt","endFramePrompt":null,"aspectRatio":"16:9","references":[]}], "userDecisions":[] }`
  return `{
  "summary":"", "shots":[{"order":1,"shotKey":"shot-1","title":"","scriptExcerpt":"","duration":8,"aspectRatio":"16:9","activeReferences":[{"assetId":"","assetName":"","mediaId":null}],"firstFrame":"","spatialBlocking":"","optics":{"diagonalFieldOfView":"47°","cameraDistance":"","visibleOutcome":"","driftLock":""},"camera":"","actionTiming":[{"from":0,"to":4,"action":""}],"physics":"","lighting":"","audio":"","continuityIn":{"characterStates":[{"assetId":"","stateId":"","visibleFacts":[]}],"propStates":[{"assetId":"","stateId":"","holder":null,"position":"","condition":""}],"screenDirection":"","gazeLines":[],"lightingDirection":"","geographyFacts":[]},"continuityOut":{"characterStates":[{"assetId":"","stateId":"","visibleFacts":[]}],"propStates":[{"assetId":"","stateId":"","holder":null,"position":"","condition":""}],"screenDirection":"","gazeLines":[],"lightingDirection":"","geographyFacts":[]},"generationPrompt":"English Seedance prompt"}], "userDecisions":[] }`
}

export function buildDirectorStageRepairPrompt(input: {
  stage: DirectorEditableStage
  invalidOutput: unknown
  issues: Array<{ path: string; message: string }>
}) {
  const invalidJson = JSON.stringify(input.invalidOutput)
  return [
    `你刚才返回的 ${input.stage.toUpperCase()} 内容可用，但 JSON 结构没有通过程序校验。`,
    '只修复字段结构、字段名和数据类型；保留原有角色、资产、镜头与创作判断，不要删减已有内容。',
    'references 每一项必须是 {"assetId":"","assetName":"","mediaId":null} 对象，不能是字符串。',
    '所有指定字段都必须存在；允许为空数组的字段使用 []，允许为空值的字段使用 null。',
    `校验问题：\n${input.issues.map((issue, index) => `${index + 1}. ${issue.path || '<root>'}: ${issue.message}`).join('\n')}`,
    `严格目标形状：\n${directorStageJsonShape(input.stage)}`,
    `需要修复的原始 JSON：\n${invalidJson.slice(0, 120_000)}`,
    '最外层直接返回一个完整 JSON 对象，不要 markdown、解释或数组包装。',
  ].join('\n\n')
}

export function buildDirectorStagePrompt(stage: DirectorEditableStage, context: StageContext) {
  const system = stage === 'acting' ? actingSystem : stage === 'lira' ? liraSystem : cinedanceSystem
  const prompt = [
    `制作：${context.productionName}`,
    `项目：${context.project.name}`,
    `统一画风：${context.project.visualStyle}`,
    context.project.customStylePrompt ? `自定义风格：${context.project.customStylePrompt}` : '',
    context.episode ? `剧本标题：${context.episode.title}\n剧本正文：\n${context.episode.content}` : '',
    `导入快照：\n${JSON.stringify(context.sourceSnapshot)}`,
    context.previousOutputs.acting ? `已确认 ACTING：\n${JSON.stringify(context.previousOutputs.acting)}${stage === 'lira' ? '\nLIRA 必须为 ACTING 中每一个 characterProfile 输出至少一个 characterStates 项，不得遗漏剧本角色。' : ''}` : '',
    context.previousOutputs.lira ? `已确认 LIRA：\n${JSON.stringify(context.previousOutputs.lira)}` : '',
    context.feedback ? `用户修改意见（优先执行）：\n${context.feedback}` : '',
    `严格返回以下 JSON 形状，数组按剧本需要扩展，不得漏字段：\n${directorStageJsonShape(stage)}`,
  ].filter(Boolean).join('\n\n')
  return { system, prompt }
}
