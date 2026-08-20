const SCENE_VISUAL_CUE = /空间|陈设|前景|中景|背景|建筑|墙|门|窗|地面|路面|道路|街道|桥|河|湖|海|山|树林|树木|庭院|小区|岗亭|栏杆|房间|客厅|卧室|书房|厨房|餐厅|大厅|走廊|车厢|车内|车外|汽车|车辆|站台|书架|沙发|桌|椅|柜|床|灯|光|影|天空|空气|天气|晨露|雾|雨|雪|潮湿|清冷|材质|金属|水泥|木质|石材|玻璃|砖墙|色调/u
const SCENE_DYNAMIC_CUE = /[“”「」『』你我他她]|(?:说|问|回答|喊|叫|对白|画外音|旁白|内心独白|拨号|接通|挂断|铃响|喘气|呼吸|深吸|哭|笑|看向|望向|盯着|抬眼|低头|抬头|回头|转头|张望|点头|摇头|转身|走向|走进|走出|进入|离开|跨入|缓步|迈步|跑|逃跑|追赶|冲出|坐下|坐进|站起|站在|坐在|躺|跪|蹲|俯身|弯腰|扶着|扶住|抓住|握住|拽着|牵着|拉着|推着|扯住|按住|按在|搂住|抱住|拥抱|搂抱|亲吻|亲了|吻了|凑近|靠近|贴近|踉跄|跌倒|摔倒|滑倒|挣扎|挥手|伸手|抬手|放下|拿起|启动|驶离|递过|滑动|发到|屏蔽|吐|渗血|汗水|唾沫|嘴里|脸上|手中|脚下|身体|神情|表情|眼神|嘴角|眉头|手腕|卫衣|外套|人物|角色|拿出|掏出|递出|推开|拉开|按下|点击|工作|整理|开始|结束)/u
const SCENE_DIALOGUE_CUE = /(?:^|[，,；;。\s])(?!(?:时间|地点|色温|光线|天气|空间|材质|前景|中景|背景)[：:])[^，,；;。：:\n]{2,24}[：:]/u
const SCENE_PRODUCTION_CUE = /(?:^资产名称[：:]|四宫格|设定图|超写实|电影级|真人影视|摄影机|焦段|光圈|景深|对焦|视角|航拍|俯瞰|仰视|侧面|背面|画质|8K|HDR|CG|风格|美学|构图准确|主体清晰|透视自然|高光与暗部保留细节|场景资产主图|沿用场景资产|禁止项|承接说明)/u

function compact(value: string, maximum: number) {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trim()}…`
}

function normalizedKey(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function sceneClauseIsDynamic(clause: string, excludedTerms: string[] = []) {
  const content = clause.replace(/^\d+(?:\.\d+)?~\d+(?:\.\d+)?s[：:]\s*/u, '')
  return SCENE_DYNAMIC_CUE.test(content)
    || SCENE_DIALOGUE_CUE.test(content)
    || excludedTerms.some((term) => term.trim() && clause.includes(term.trim()))
}

export function conciseStoryboardSceneFacts(
  value: string,
  maximum = 180,
  excludedTerms: string[] = [],
) {
  const cleaned = value
    .replace(/场景资产唯一锚点“[^”]+”：/gu, '')
    .replace(/场景资产“[^”]+”[：:]?/gu, '')
    .replace(/禁止将场景“[^”]+”[^。；;]*(?:[。；;]|$)/gu, '')
    .replace(/(?:人物锁定|动作对白|声音设计|配音要求|景别机位运动|首帧画面|尾帧画面|镜间衔接|禁止项)[：:][^\n]*/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const clauses = cleaned
    .split(/[。！？!?；;\n]+/u)
    .map((clause) => clause.replace(/^[，,：:“”「」『』\s]+|[，,：:“”「」『』\s]+$/gu, '').trim())
    .filter((clause) => clause.length >= 4)
    .filter((clause) => SCENE_VISUAL_CUE.test(clause))
    .filter((clause) => !sceneClauseIsDynamic(clause, excludedTerms))
    .filter((clause) => !SCENE_PRODUCTION_CUE.test(clause))
  const unique: string[] = []
  const keys = new Set<string>()
  for (const clause of clauses) {
    const key = normalizedKey(clause)
    if (!key || keys.has(key)) continue
    keys.add(key)
    unique.push(clause)
    if (unique.length >= 3) break
  }
  return compact(unique.join('；'), maximum)
}

export function conciseStoryboardLighting(value: string, maximum = 70, excludedTerms: string[] = []) {
  const clauses = value
    .replace(/\s+/gu, ' ')
    .split(/[。！？!?；;\n]+/u)
    .map((clause) => clause.replace(/^[，,：:“”「」『』\s]+|[，,：:“”「」『』\s]+$/gu, '').trim())
    .filter((clause) => clause.length >= 3 && !sceneClauseIsDynamic(clause, excludedTerms))
  return compact([...new Set(clauses)].slice(0, 2).join('；'), maximum)
}

export function storyboardSceneHasDynamicContent(value: string, excludedTerms: string[] = []) {
  return value
    .split(/[。！？!?；;\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => sceneClauseIsDynamic(clause, excludedTerms))
}

export function conciseStoryboardSceneSection(input: {
  timeLocation: string
  sceneName: string
  environment: string
  lighting: string
  excludedTerms?: string[]
}) {
  const environment = conciseStoryboardSceneFacts(input.environment, 135, input.excludedTerms)
  const lighting = conciseStoryboardLighting(input.lighting, 60, input.excludedTerms)
  const location = input.timeLocation.trim() || input.sceneName.trim()
  return `${[
    location.replace(/[。；;]+$/u, ''),
    environment,
    lighting,
  ].filter(Boolean).join('。').slice(0, 219).replace(/[。；;]+$/u, '')}。`
}

export function compactLegacyStoryboardSceneSection(
  value: string,
  fallbackSceneName = '',
  fallbackEnvironment = '',
  excludedTerms: string[] = [],
) {
  const firstClause = value.split(/[。\n]/u, 1)[0]?.trim() || ''
  const location = firstClause.length <= 80 && !sceneClauseIsDynamic(firstClause, excludedTerms)
    ? firstClause
    : fallbackSceneName.trim()
  return conciseStoryboardSceneSection({
    timeLocation: location || fallbackSceneName.trim(),
    sceneName: fallbackSceneName,
    environment: `${fallbackEnvironment}。${value.slice(firstClause.length)}`,
    lighting: '',
    excludedTerms,
  })
}

export function sanitizeStoryboardPromptSceneSection(
  value: string,
  fallbackSceneName = '',
  fallbackEnvironment = '',
  excludedTerms: string[] = [],
) {
  const sceneHeading = '【场景】'
  const timelineHeading = '【视频分镜】'
  const headingStart = value.indexOf(sceneHeading)
  if (headingStart < 0) return value
  const sceneStart = headingStart + sceneHeading.length
  const timelineStart = value.indexOf(timelineHeading, sceneStart)
  if (timelineStart < 0) return value
  const rawScene = value.slice(sceneStart, timelineStart).trim()
  const assetMentions = [...new Set(rawScene
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^@[^@\n]+$/u.test(line)))]
  const scene = compactLegacyStoryboardSceneSection(
    rawScene,
    fallbackSceneName,
    fallbackEnvironment,
    excludedTerms,
  )
  return `${value.slice(0, sceneStart).trimEnd()}\n${[
    ...assetMentions,
    scene,
  ].filter(Boolean).join('\n')}\n${value.slice(timelineStart)}`
}
