import { prisma } from '@/lib/db'

const projectId = process.argv[2]?.trim()
const apply = process.argv.includes('--apply')

if (!projectId) {
  throw new Error('Usage: tsx scripts/compact-open-school-episode-two.ts <project-id> [--apply]')
}

const timelines: Record<number, string> = {
  1: [
    '0~6s：入口内侧全景，洛雪微左手握住林夏右手腕，带他走进大厅；林夏左手拖着行李箱，踉跄一步后站稳，神情困惑。',
    '6~15s：三人中景，中年女工作人员上前微笑：“洛小姐，都准备好了，这边请。”洛雪微点头一次，仍握着林夏手腕跟随；工作人员在前，洛雪微居中，林夏在后。',
  ].join('\n'),
  2: [
    '0~5s：双人中近景，洛雪微松开林夏手腕，双手按住他肩膀让他坐在红布前；行李箱滑到脚边。林夏皱眉：“等等，我还没同意。”',
    '5~10s：洛雪微过肩近景，她俯身靠近，眼神锐利：“三万块都收了，现在反悔？”林夏身体一僵。',
    '10~15s：正面中景，两人坐在红布前。林夏勉强微笑，洛雪微坐直看向镜头；快门声响起，林夏的笑容随即消失。',
  ].join('\n'),
  3: [
    '0~5s：窗口双人中景，工作人员递上表格，洛雪微快速填写；林夏接过笔，被迫签字，手指微颤。',
    '5~10s：红本子特写，工作人员盖章后递出两本结婚证；林夏瞳孔放大，僵在窗口前。',
    '10~15s：林夏面部近景，他盯着手机到账金额，眉头紧锁，内心独白：“五万？刚才说三万，现在又加两万？”',
  ].join('\n'),
  4: [
    '0~5s：林夏近景，仍盯着手机，内心独白：“这女人，我成二婚了，亏大了！”',
    '5~10s：洛雪微过肩中景，她平静交代：“以后遇到什么麻烦，手机上联系我。”林夏咽了下口水，轻轻点头。',
    '10~15s：洛雪微近景，视线落在林夏脸上：“在临海市，我应该都能帮你摆平。”',
  ].join('\n'),
  5: [
    '0~5s：双人中近景，洛雪微微挑眉：“你还有什么问题吗？”',
    '5~10s：林夏近景，他迟疑片刻：“呃，所以我们这算是夫妻了？”洛雪微在对面点头。',
    '10~15s：洛雪微近景，她平静回答：“你可以这么理解。”林夏尴尬地挠了挠头。',
  ].join('\n'),
  6: [
    '0~5s：洛雪微近景，语气平静：“我需要一张结婚证来解决我的麻烦。”',
    '5~10s：双人中近景，洛雪微继续：“你要是觉得亏了，你再开个价吧。”',
    '10~15s：林夏近景，他抬眼打量洛雪微，内心独白：“开价？那我不真成卖的了？”神情由纠结转为释然。',
  ].join('\n'),
  7: [
    '0~5s：林夏近景，嘴角微扬，内心独白：“不过卖给富婆好像也不亏。”',
    '5~10s：双人中近景，林夏试探：“那个，什么要求都可以？”洛雪微挑眉看着他。',
    '10~15s：洛雪微近景，她坚定回答：“当然，只要不违法，你的要求我都可以答应。”林夏轻轻点头。',
  ].join('\n'),
  8: [
    '0~5s：林夏近景，他看着洛雪微，内心独白：“这可是你说的。”随后向前迈出一步。',
    '5~10s：双人中近景，林夏突然凑近，只在洛雪微唇上亲一下便立刻退开；洛雪微愣住，瞳孔微缩。',
    '10~15s：跟拍中景，林夏抓起书包跑向大厅出口，回头喊：“老婆再见！”洛雪微轻触嘴唇，低声说：“吻了我还想跑？你跑得掉吗？”',
  ].join('\n'),
  9: [
    '0~5s：民政局门口侧面中景，林夏右手拖行李箱、左手推门，冲出大门跑下台阶，没有回头。',
    '5~10s：洛雪微中近景，她缓步走出大门并坐进迈巴赫后座。管家从驾驶位回头：“小姐，回学校吗？”',
    '10~15s：切到迈巴赫车内，过肩中近景。洛雪微说：“管家，帮我找个人：林夏。”管家回答：“小姐，我已经帮你找好了。”随后递出平板。',
  ].join('\n'),
  10: [
    '0~4s：平板特写，洛雪微滑动林夏的资料，嘴角轻扬：“临大的学生吗？有意思，你逃不掉的。”',
    '4~7s：洛雪微中近景，她拿起手机，再举起结婚证封面对准镜头拍照。',
    '7~11s：洛雪微放下手机看向管家：“送我回学校，今天是新生入学的日子。”',
    '11~15s：洛雪微近景：“我还要帮导师处理事情。”管家点头：“好的，小姐。”迈巴赫随即启动。',
  ].join('\n'),
  11: [
    '0~3s：大学报到处全景，林夏跑进校门后减速停下，气喘吁吁地回头，确认无人追来。',
    '3~7s：过肩中景，辅导员季丹丹递出学生证：“林夏，欢迎入学。”林夏右手接过：“谢谢辅导员。”',
    '7~11s：切到校园长椅，林夏坐下，从背包取出结婚证和学生证：“那女人应该不会回来杀了我吧？”',
    '11~15s：林夏近景，他看着结婚证，嘴角微扬：“不过不得不说，她嘴巴还挺软的，感觉不赖。”',
  ].join('\n'),
  12: [
    '0~4s：林夏过肩中近景，他拿手机拍下结婚证封面：“算了，跟老爹老妈说一下吧。”',
    '4~8s：林夏低头发送照片，轻声补充：“正好还能让他们别催找对象了。”',
    '8~12s：手机屏幕特写，母亲头像和消息“儿子，你……”突然出现；林夏笑容消失，盯着屏幕，手指悬停。仅允许手机中的剧情消息，不生成字幕。',
  ].join('\n'),
}

function replaceTimeline(videoPrompt: string, timeline: string) {
  const heading = /^【视频分镜】\s*$/mu.exec(videoPrompt)
  if (!heading) throw new Error('分镜缺少【视频分镜】段落')
  const timelineStart = heading.index + heading[0].length
  return `${videoPrompt.slice(0, timelineStart)}\n${timeline}`
}

const episode = await prisma.scriptEpisode.findUniqueOrThrow({
  where: { projectId_episodeNumber: { projectId, episodeNumber: 2 } },
  select: {
    id: true,
    title: true,
    content: true,
    storyboards: {
      orderBy: [{ episodeSceneNumber: 'asc' }, { sceneNumber: 'asc' }],
      select: {
        id: true,
        episodeSceneNumber: true,
        title: true,
        videoPrompt: true,
        selectedVideoId: true,
        _count: { select: { videos: true } },
      },
    },
  },
})

if (episode.title !== '红本子' || episode.storyboards.length !== 12) {
  throw new Error(`目标集不匹配：${episode.title}，${episode.storyboards.length} 条分镜`)
}
for (const evidence of ['林夏突然凑近，在洛雪微唇上亲了一下', '母亲的头像跳动', '儿子，你']) {
  if (!episode.content.includes(evidence)) throw new Error(`锁定剧本缺少核对依据：${evidence}`)
}

const changes = episode.storyboards.map((storyboard) => {
  const number = storyboard.episodeSceneNumber || 0
  const timeline = timelines[number]
  if (!timeline) throw new Error(`缺少分镜 ${number} 的短版时间轴`)
  const currentPrompt = storyboard.videoPrompt || ''
  return {
    storyboard,
    timeline,
    currentPrompt,
    nextPrompt: replaceTimeline(currentPrompt, timeline),
  }
})

if (apply) {
  await prisma.$transaction(changes.map(({ storyboard, nextPrompt }) => (
    prisma.storyboard.update({
      where: { id: storyboard.id },
      data: { videoPrompt: nextPrompt },
    })
  )))
}

console.log(JSON.stringify({
  projectId,
  episode: 2,
  title: episode.title,
  applied: apply,
  changed: changes.filter(({ currentPrompt, nextPrompt }) => currentPrompt !== nextPrompt).length,
  preservedVideos: changes.reduce((total, { storyboard }) => total + storyboard._count.videos, 0),
  selectedVideos: changes.filter(({ storyboard }) => storyboard.selectedVideoId).length,
  storyboards: changes.map(({ storyboard, currentPrompt, nextPrompt, timeline }) => ({
    number: storyboard.episodeSceneNumber,
    title: storyboard.title,
    before: currentPrompt.length,
    after: nextPrompt.length,
    videos: storyboard._count.videos,
    timeline,
  })),
}, null, 2))

await prisma.$disconnect()
