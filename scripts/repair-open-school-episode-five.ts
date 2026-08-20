import { prisma } from '../src/lib/db'
import { extractRequiredStoryboardDialogueLines } from '../src/lib/preproduction-prompts'
import { validateFinalStoryboardDialogue, type FinalStoryboardDialogueDocument } from '../src/lib/storyboard-dialogue-validation'
import { createStoryboardRevision } from '../src/lib/storyboard-revisions'
import { syncStoryboardAssetLinks } from '../src/lib/storyboards'
import {
  materializeStoryboards,
  storyboardContinuityIssues,
  storyboardDialogueMissing,
  type CompactShotInput,
} from '../src/lib/worker/text-generation'

const projectId = process.argv[2]?.trim() || 'cmsd39w7g0001mx3qmwcibd36'
const episodeNumber = 5
const apply = process.argv.includes('--apply')

const common = {
  q: '保留演员现场对白、自然呼吸和现场环境声；无旁白、无后期配音感、无背景音乐、无字幕、无画面文字。',
  o: '保留现场对白、环境声和必要音效；严格不生成BGM，不生成字幕。',
  z: '禁止重复人物、重复对白、人物换脸、人物复制、无过程换位、动作回退、道具易手、身体穿模和场景跳变。',
}

function shot(input: CompactShotInput): CompactShotInput {
  return {
    r: '无新增关键道具；手机、行李和车辆始终保持原归属。',
    m: '动作沿可见路径连续完成，重心和脚步符合重力；接触点不瞬移，结束姿态严格承接下一镜。',
    x: '本镜尾帧作为下一镜起始状态；不重复已经完成的对白或动作。',
    ...common,
    ...input,
    d: 15,
  }
}

const shots: CompactShotInput[] = [
  shot({
    t: '校园主干道：删好友对峙',
    n: '日/外｜校园主干道',
    i: '顾玉荣质问林夏删好友；林夏以冷淡态度回应，建立两人的矛盾。',
    p: '林夏和顾玉荣已经面对面站在校园主干道，林夏手持手机，顾玉荣情绪激动。',
    h: '林夏：清瘦男生，短发，休闲校园服，位于画面左侧，手持手机。顾玉荣：年轻女性，位于画面右侧，正面对着林夏。',
    e: '日间校园主干道，树荫、灰色步道、远处校园建筑和少量虚化行人。',
    l: '日间自然光，树影落在步道上，人物面部光线清晰。',
    c: '双人中近景，固定机位，保持林夏左侧、顾玉荣右侧。',
    f: '林夏低头看手机；顾玉荣站在右侧怒视林夏，双方保持一臂距离。',
    s: '先顾玉荣质问；随后林夏低头回答；最后顾玉荣继续追问电话未接。',
    v: `0~5s：双人中近景，顾玉荣怒视林夏，胸口起伏：“你干嘛删我好友！”林夏低头看手机，不抬头。
5~10s：林夏保持原站位，语气随意：“好友满了，清理点无关紧要的人。”顾玉荣的表情从愤怒转为难以置信。
10~15s：顾玉荣身体前倾，声音拔高：“什么叫无关紧要！那我打你电话你干嘛不接！？”林夏缓慢抬眼看她。`,
    a: '顾玉荣：你干嘛删我好友！；林夏：好友满了，清理点无关紧要的人。；顾玉荣：什么叫无关紧要！那我打你电话你干嘛不接！？',
    g: '林夏抬眼看向顾玉荣，手机仍在手中；顾玉荣站在右侧前倾，双方位置未改变。',
  }),
  shot({
    t: '校园主干道：冷淡回应',
    n: '时间承接上一镜｜日/外｜校园主干道',
    i: '林夏用平淡语气回应，进一步激怒顾玉荣。',
    p: '承接上一镜尾帧；林夏在左侧抬眼，顾玉荣在右侧前倾，双方保持一臂距离。',
    h: '林夏：清瘦男生，短发，休闲校园服，画面左侧。顾玉荣：年轻女性，画面右侧。',
    e: '日间校园主干道，树荫、灰色步道和远处校园建筑保持不变。',
    l: '延续上一镜的日间自然光和树影。',
    c: '双人中近景转林夏近景，固定机位，不改变左右位置。',
    f: '林夏在左侧平静看向顾玉荣；顾玉荣在右侧指向林夏。',
    s: '先林夏回答；随后顾玉荣指责并质问；最后林夏收起手机。',
    v: `0~5s：林夏近景，目光平静：“我当骚扰电话了。”顾玉荣在画面右侧听见后愤怒发抖。
5~10s：顾玉荣指向林夏，声音发紧：“你！！！林夏你到底什么意思啊？”林夏收起手机，表情没有变化。
10~15s：林夏平静看着顾玉荣：“没什么意思啊。”顾玉荣呼吸急促，向前逼近半步。`,
    a: '林夏：我当骚扰电话了。；顾玉荣：你！！！林夏你到底什么意思啊？；林夏：没什么意思啊。',
    g: '林夏收起手机，仍在画面左侧；顾玉荣在右侧逼近半步，双方尚未接触。',
  }),
  shot({
    t: '校园主干道：划清界限',
    n: '时间承接上一镜｜日/外｜校园主干道',
    i: '顾玉荣质问态度，林夏明确结束关系并准备离开。',
    p: '承接上一镜尾帧；顾玉荣在右侧逼近半步，林夏在左侧收好手机。',
    h: '林夏：清瘦男生，画面左侧，手机已收好。顾玉荣：年轻女性，画面右侧。',
    e: '日间校园主干道，树荫、灰色步道和远处校园建筑保持不变。',
    l: '延续日间自然光，人物轮廓清晰。',
    c: '双人中景，固定机位，最后轻微跟随林夏转身。',
    f: '林夏左侧面对顾玉荣；顾玉荣右侧正面逼近。',
    s: '先顾玉荣质问；随后林夏回答并转身；最后林夏开始离开，顾玉荣留在原地。',
    v: `0~5s：顾玉荣近景，眉头紧锁：“你什么态度啊？”林夏在前景左侧皱眉，没有后退。
5~11s：林夏中近景，语气平淡：“姑奶奶，我现在和你没关系，我还要吃饭就不奉陪了。”说完只转身一次。
11~15s：林夏向画面左前方走开，顾玉荣留在原地愣住，二人没有接触。`,
    a: '顾玉荣：你什么态度啊？；林夏：姑奶奶，我现在和你没关系，我还要吃饭就不奉陪了。',
    g: '林夏已经转身向画面左前方离开；顾玉荣仍在原地，未追上去。',
  }),
  shot({
    t: '校园主干道：愤然离开',
    n: '时间承接上一镜｜日/外｜校园主干道',
    i: '顾玉荣叫住林夏并发火，林夏不回头继续走。',
    p: '承接上一镜尾帧；林夏背对顾玉荣向前走，顾玉荣留在后方。',
    h: '林夏：清瘦男生，背对镜头向画面左前方走。顾玉荣：年轻女性，位于后方。',
    e: '日间校园主干道，灰色步道、树影和远处校园建筑保持不变。',
    l: '延续日间自然光，林夏背影和顾玉荣面部均清晰可见。',
    c: '中景固定机位，先看林夏背影，再保持顾玉荣在后景。',
    f: '林夏在画面左前方背对镜头；顾玉荣站在后方看向林夏。',
    s: '先顾玉荣喊住林夏；随后林夏不回头加快脚步；最后顾玉荣跺脚并转身离开。',
    v: `0~5s：顾玉荣站在后方大喊：“林夏！你给我站住！”林夏没有回头，继续向画面左前方走。
5~10s：林夏加快脚步，背影逐渐拉远；顾玉荣气得跺脚。
10~15s：顾玉荣冲着林夏背影喊：“混蛋！好！不理就不理，以后也别想让我理你！”随后愤然转身，林夏不回头。`,
    a: '顾玉荣：林夏！你给我站住……；顾玉荣：混蛋！好！不理就不理，以后也别想让我理你！',
    g: '林夏已经走远并离开画面左侧；顾玉荣转身背对林夏，留在校园主干道。',
  }),
  shot({
    t: '校园主干道：室友议论',
    n: '时间承接上一镜｜日/外｜校园主干道',
    i: '陈浩询问林夏与顾玉荣的反常关系，吕嘉豪敷衍解释。',
    p: '林夏和顾玉荣已经离开当前画面；三名室友留在校园主干道旁。',
    h: '陈浩：年轻男生，站在画面左侧。吕嘉豪：年轻男生，站在画面右侧。陆野：年轻男生，站在两人后方，只做无对白反应。',
    e: '日间校园主干道，树影、灰色步道和远处校园建筑保持不变。',
    l: '自然日光，三人的脸部和身体轮廓清晰。',
    c: '三人中景转陈浩与吕嘉豪双人中近景，固定机位。',
    f: '陈浩左侧看向吕嘉豪；吕嘉豪右侧故作镇定；陆野在后方看向林夏离开的方向。',
    s: '先陈浩挠头提问；随后吕嘉豪捋刘海回答；最后陆野保持沉默看向远处。',
    v: `0~6s：陈浩挠头看向吕嘉豪：“豪哥，你不是说女生不会主动找没通过考验的男生吗？那林夏怎么反过来了？”
6~11s：吕嘉豪捋了捋刘海，故作镇定：“呃……这个是特殊情况，我还没讲呢。”
11~15s：陈浩疑惑看着吕嘉豪；陆野沉默看向林夏消失的方向，三人不再说话。`,
    a: '陈浩：豪哥，你不是说女生不会主动找没通过考验的男生吗？那林夏怎么反过来了？；吕嘉豪：呃……这个是特殊情况，我还没讲呢。',
    g: '陈浩和吕嘉豪留在原地，陆野仍看向林夏离开的方向；当前画面只有三名可见人物。',
  }),
  shot({
    t: '中心路口人行道：意外重逢',
    n: '日/外｜中心路口人行道',
    i: '林夏独自行走时遇到洛雪微，洛雪微发现他并产生玩味。',
    p: '从校园主干道切换到中心路口人行道；上一场景人物完全退出。',
    h: '林夏：清瘦男生，独自从画面左侧向右侧走，低头思考。洛雪微：年轻女性，从黑色迈巴赫后座下车，位于画面右侧。',
    e: '日间中心路口人行道，黑色迈巴赫停在路边，城市建筑、斑马线和缓慢车流。',
    l: '日间自然光，车身反光清晰，人物面部光线自然。',
    c: '林夏侧面跟拍转车辆与洛雪微中景，固定镜头。',
    f: '林夏沿人行道向画面右侧走；迈巴赫停在右侧路边，洛雪微从后座下车。',
    s: '先林夏低头自言自语；随后迈巴赫停在路边；然后洛雪微下车看见林夏并自语。',
    v: `0~5s：林夏沿人行道向前走，眉头微皱，自言自语：“除了吃饭我还要干嘛来着？哦对！行李！”
5~10s：黑色迈巴赫停在路边，洛雪微从后座下车，看见远处的林夏，嘴角微扬。
10~15s：洛雪微看着林夏，轻声自语：“嘿，没想到这么快就遇到了……小东西，看你这次还怎么逃。”林夏仍低头向前走，没有发现她。`,
    a: '林夏：除了吃饭我还要干嘛来着？哦对！行李！；洛雪微：嘿~没想到这么快就遇到了……小东西，看你这次还怎么逃。',
    g: '洛雪微站在人行道右侧看向林夏；林夏从左侧继续向前，双方尚未接触。',
  }),
  shot({
    t: '中心路口人行道：被拉住',
    n: '时间承接上一镜｜日/外｜中心路口人行道',
    i: '洛雪微抓住林夏并揭开亲吻与婚姻话题，林夏惊慌辩解。',
    p: '承接上一镜尾帧；林夏向前走，洛雪微已经在其后方一臂距离内。',
    h: '林夏：清瘦男生，画面左侧向前走。洛雪微：年轻女性，位于林夏后侧，右手准备抓住林夏左臂。',
    e: '日间中心路口人行道，黑色迈巴赫停在路边，城市车流缓慢。',
    l: '延续日间自然光，保持人物面部与手臂接触点清晰。',
    c: '双人中近景，侧后方固定机位，保持林夏左侧、洛雪微右侧。',
    f: '林夏背对洛雪微向前走；洛雪微从后方靠近。',
    s: '先洛雪微抓住林夏左臂；随后林夏被拽停并回头；最后洛雪微说出质问，林夏结巴解释。',
    v: `0~5s：洛雪微从林夏身后伸手抓住他的左臂，林夏被拽得一顿，回头时瞳孔骤缩：“！！！”
5~10s：洛雪微保持右手抓住林夏左臂，盯着他：“哼？吻了我还想逃？”林夏身体僵住。
10~15s：林夏看着洛雪微，咽了口唾沫：“那个……咱……咱们不是领证了吗？夫妻之间亲一下，不算什么吧？”`,
    a: '林夏：！！！；洛雪微：哼？吻了我还想逃？；林夏：那个……咱……咱们不是领证了吗？夫妻之间亲一下，不算什么吧？',
    g: '洛雪微仍抓住林夏左臂；林夏回身面对她，身体僵硬，双方位置未改变。',
  }),
  shot({
    t: '中心路口人行道：承认夫妻',
    n: '时间承接上一镜｜日/外｜中心路口人行道',
    i: '洛雪微抓住林夏承认夫妻关系的漏洞，林夏把责任推回给她。',
    p: '承接上一镜尾帧；洛雪微抓住林夏左臂，林夏回身面对她。',
    h: '林夏：清瘦男生，位于画面左侧。洛雪微：年轻女性，位于画面右侧，右手抓住林夏左臂。',
    e: '日间中心路口人行道，黑色迈巴赫停在路边，城市车流缓慢。',
    l: '延续日间自然光，接触点和两人面部清晰可见。',
    c: '双人中近景，正面固定机位，保持左右位置不变。',
    f: '林夏左侧紧张看向洛雪微；洛雪微右侧带着玩味笑意。',
    s: '先洛雪微反问；随后林夏把领证责任推回给洛雪微；最后洛雪微听完后嘴角上扬。',
    v: `0~5s：洛雪微轻笑，仍抓住林夏左臂：“所以你也承认我们是夫妻了？”林夏眼神躲闪。
5~11s：林夏语气变得理直气壮：“这可是你拉着我去领证的啊，我是被迫的，真要算，你应该要对我负责。”
11~15s：洛雪微嘴角轻扬，目光锁定林夏；林夏说完后保持僵硬站姿，没有转身或后退。`,
    a: '洛雪微：所以你也承认我们是夫妻了？；林夏：这可是你拉着我去领证的啊，我是被迫的，真要算，你应该要对我负责。',
    g: '洛雪微仍在画面右侧抓住林夏左臂；林夏在左侧僵住，双方没有换位。',
  }),
  shot({
    t: '中心路口人行道：拉近与反问',
    n: '时间承接上一镜｜日/外｜中心路口人行道',
    i: '洛雪微用拉近和触碰下巴制造暧昧压力，林夏彻底语塞。',
    p: '承接上一镜尾帧；林夏和洛雪微保持原左右位置，洛雪微仍抓住林夏左臂。',
    h: '林夏：清瘦男生，画面左侧，紧张僵住。洛雪微：年轻女性，画面右侧，抓住林夏左臂。',
    e: '日间中心路口人行道，黑色迈巴赫停在路边，城市车流缓慢。',
    l: '延续自然日光，人物眼神和手部动作清晰。',
    c: '双人中近景转林夏面部近景，固定机位。',
    f: '洛雪微在右侧，林夏在左侧，两人面对面保持清晰轮廓。',
    s: '先洛雪微拉近林夏一步并说负责；随后她抬手轻触林夏下巴；最后林夏语塞，洛雪微追问。',
    v: `0~5s：洛雪微右手用力，将林夏拉近一步，林夏重心被带向前但双脚不离地；洛雪微轻声说：“负责？”
5~10s：洛雪微松开林夏左臂，右手指尖轻轻划过林夏下巴；林夏呼吸一滞，身体保持原位。
10~15s：林夏嘴唇微张：“阿巴阿巴。”洛雪微挑眉看他：“嗯？你说什么？”`,
    a: '洛雪微：负责？；林夏：阿巴阿巴。；洛雪微：嗯？你说什么？',
    g: '洛雪微右手停在林夏下巴旁；林夏僵在原地，嘴唇微张，双方没有亲吻或进一步接触。',
  }),
  shot({
    t: '中心路口人行道：被带走',
    n: '时间承接上一镜｜日/外｜中心路口人行道',
    i: '洛雪微带林夏离开，结束本集中心冲突并留下暧昧钩子。',
    p: '承接上一镜尾帧；林夏仍僵在原地，洛雪微的手停在他下巴旁。',
    h: '林夏：清瘦男生，画面左侧。洛雪微：年轻女性，画面右侧，面对林夏。',
    e: '日间中心路口人行道，黑色迈巴赫停在路边，城市车流缓慢。',
    l: '延续日间自然光，车辆和人行道方向清晰。',
    c: '双人中近景转侧面中景，固定机位轻微跟拍向迈巴赫。',
    f: '林夏左侧僵住；洛雪微右侧看向林夏，迈巴赫位于两人前方。',
    s: '先林夏结巴说没什么；随后洛雪微说跟她走并转身；最后洛雪微拉住林夏手腕，林夏踉跄跟上。',
    v: `0~5s：林夏回过神，视线躲闪：“没……没什么。”洛雪微仍站在右侧看着他。
5~10s：洛雪微嘴角轻扬：“那就好。跟我走。”她转身朝黑色迈巴赫方向迈步。
10~15s：洛雪微伸手拉住林夏手腕，林夏被拽得踉跄一步，随后跟上；镜头沿同一方向跟拍，两人不回头。`,
    a: '林夏：没……没什么。；洛雪微：那就好。跟我走。',
    g: '洛雪微拉着林夏向黑色迈巴赫走去；林夏在她身后跟随，行走方向保持一致。',
  }),
]

const project = await prisma.project.findUniqueOrThrow({
  where: { id: projectId },
  select: { visualStyle: true, customStylePrompt: true },
})
const items = materializeStoryboards({
  shots,
  visualStyle: project.visualStyle,
  customStylePrompt: project.customStylePrompt,
})

if (items.length !== 10 || items.some((item) => item.duration !== 15)) {
  throw new Error(`Episode 5 repair must contain 10 fifteen-second storyboards: ${JSON.stringify(items.map((item) => item.duration))}`)
}
const continuityIssues = storyboardContinuityIssues(shots)
if (continuityIssues.length > 0) {
  throw new Error(`Episode 5 continuity check failed: ${JSON.stringify(continuityIssues)}`)
}

const episode = await prisma.scriptEpisode.findUniqueOrThrow({
  where: { projectId_episodeNumber: { projectId, episodeNumber } },
  select: { id: true, content: true, locked: true },
})
if (!episode.locked) throw new Error('Episode 5 is not locked')

const dialogueDocuments: FinalStoryboardDialogueDocument[] = items.map((item, index) => ({
  id: `episode-five-repair-${index + 1}`,
  number: index + 1,
  title: item.title,
  videoPrompt: item.videoPrompt,
}))
const finalDialogueIssues = validateFinalStoryboardDialogue(dialogueDocuments, episode.content)
if (finalDialogueIssues.length > 0) {
  throw new Error(`Episode 5 duplicate dialogue check failed: ${JSON.stringify(finalDialogueIssues)}`)
}

const knownCharacters = ['林夏', '顾玉荣', '洛雪微', '陈浩', '吕嘉豪', '陆野']
const missing = extractRequiredStoryboardDialogueLines(episode.content)
  .filter((dialogue) => {
    const speaker = knownCharacters.find((name) => dialogue.speaker.includes(name)) || dialogue.speaker
    return storyboardDialogueMissing(shots, { ...dialogue, speaker })
  })
if (missing.length > 0) {
  throw new Error(`Episode 5 dialogue coverage failed: ${JSON.stringify(missing)}`)
}

const existing = await prisma.storyboard.findMany({
  where: { projectId, episodeId: episode.id, generatedByAI: true },
  orderBy: { episodeSceneNumber: 'asc' },
  include: { videos: true },
})

if (!apply) {
  console.log(JSON.stringify({
    projectId,
    episodeNumber,
    storyboardCount: items.length,
    totalSeconds: items.reduce((total, item) => total + item.duration, 0),
    storyboards: items.map((item, index) => ({ number: index + 1, title: item.title, duration: item.duration, scene: item.notes })),
  }, null, 2))
  await prisma.$disconnect()
  process.exit(0)
}

const createdIds = await prisma.$transaction(async (tx) => {
  for (const previous of existing) {
    await createStoryboardRevision(tx, previous, {
      source: 'episode_five_before_repair',
      reason: '第五集短镜头碎片化与重复对白修复前快照',
      validationReport: {
        previousStoryboardCount: existing.length,
        replacementStoryboardCount: items.length,
        preservedBeforeReplacement: true,
      },
    })
    await tx.storyboard.update({
      where: { id: previous.id },
      data: { sceneNumber: -2_000_000_000 + episodeNumber * 1_000 + (previous.episodeSceneNumber || 0) },
    })
  }

  const ids: string[] = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const created = await tx.storyboard.create({
      data: {
        projectId,
        episodeId: episode.id,
        episodeSceneNumber: index + 1,
        generatedByAI: true,
        sceneNumber: 2_000_000_000 + episodeNumber * 100 + index + 1,
        title: item.title,
        notes: item.notes || null,
        imagePrompt: item.imagePrompt || null,
        videoPrompt: item.videoPrompt,
        duration: item.duration,
        aspectRatio: item.aspectRatio,
        generateAudio: true,
        continuityIn: item.continuityIn,
        continuityOut: item.continuityOut,
      },
    })
    ids.push(created.id)
    await createStoryboardRevision(tx, created, {
      source: 'episode_five_repaired_storyboard',
      reason: '按锁定剧本删除重复对白并将相邻内容重排为15秒分镜',
      validationReport: {
        previousStoryboardCount: existing.length,
        replacementStoryboardCount: items.length,
        allDurationsFifteenSeconds: true,
        continuityIssues: [],
      },
    })
  }

  const previousIndexById = new Map(existing.map((storyboard, index) => [storyboard.id, index]))
  for (let previousIndex = 0; previousIndex < existing.length; previousIndex++) {
    const previous = existing[previousIndex]
    const replacementId = ids[Math.min(previousIndex, ids.length - 1)]
    if (!replacementId) continue
    for (const video of previous.videos) {
      const mappedSourceIds = [...new Set(video.sourceStoryboardIds.flatMap((sourceId) => {
        const sourceIndex = previousIndexById.get(sourceId)
        const mappedId = sourceIndex === undefined
          ? replacementId
          : ids[Math.min(sourceIndex, ids.length - 1)]
        return mappedId ? [mappedId] : []
      }))]
      await tx.storyboardVideo.update({
        where: { id: video.id },
        data: {
          storyboardId: replacementId,
          sourceStoryboardIds: mappedSourceIds.length > 0 ? mappedSourceIds : [replacementId],
        },
      })
    }
    await tx.storyboard.update({
      where: { id: previous.id },
      data: { selectedVideoId: null },
    })
    if (previous.selectedVideoId && previous.videos.some((video) => video.id === previous.selectedVideoId)) {
      const replacement = await tx.storyboard.findUnique({
        where: { id: replacementId },
        select: { selectedVideoId: true },
      })
      if (!replacement?.selectedVideoId) {
        await tx.storyboard.update({
          where: { id: replacementId },
          data: { selectedVideoId: previous.selectedVideoId },
        })
      }
    }
  }

  await tx.storyboard.deleteMany({ where: { id: { in: existing.map((storyboard) => storyboard.id) } } })
  return ids
}, { timeout: 30_000 })

for (const id of createdIds) await syncStoryboardAssetLinks(id)
console.log(JSON.stringify({
  projectId,
  episodeNumber,
  applied: true,
  storyboardCount: createdIds.length,
  totalSeconds: items.reduce((total, item) => total + item.duration, 0),
  storyboardIds: createdIds,
}, null, 2))
await prisma.$disconnect()
