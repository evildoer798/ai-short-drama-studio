import { prisma } from '@/lib/db'

const projectId = process.argv[2]?.trim()
const apply = process.argv.includes('--apply')

if (!projectId) {
  throw new Error('Usage: tsx scripts/compact-open-school-episode-three.ts <project-id> [--apply]')
}

const soundRule = '不要生成背景音乐（BGM），保留现场对白，允许环境声和必要音效。'

const timelines: Record<number, string> = {
  1: [
    '0~4s：林夏正面中近景，他坐在校园长椅上，手机贴在右耳，认真说：“真的，很漂亮，你放心，我丑的也不会要的。”',
    '4~12s：林夏侧面近景，林夏母亲仅以电话画外音说：“那就好，我和你爸决定了，以后每个月生活费给你加到五千块。结婚恋爱了，可不能穷了。”林夏仍坐在原位，神情由轻松转为惊讶。',
  ].join('\n'),
  2: [
    '0~3s：延续上一镜，林夏母亲仅以电话画外音说：“记得和人家小姑娘好好玩。”林夏眼睛逐渐睁大。',
    '3~5s：林夏猛地坐直，手机险些脱手又被握住，脱口而出：“What?!”',
    '5~9s：手机转账通知特写后切回林夏，他低头盯着屏幕，震惊地问：“卧槽！妈！你不是说咱家很穷，还欠了一屁股债吗？”',
    '9~12s：林夏中近景，林夏母亲以电话画外音回答：“那是以前为了让你努力学习，骗你的。”林夏僵在长椅上。',
  ].join('\n'),
  3: [
    '0~3s：林夏近景，林夏母亲以电话画外音说：“至于那一屁股债，其实是别人欠我们家的。”林夏张着嘴，一时说不出话。',
    '3~6s：镜头保持林夏侧脸，母亲继续在电话中说：“记得在大学里好好恋爱，钱不够就问我要。”林夏眉头越皱越紧。',
    '6~9s：母亲在电话中补充：“毕业了，我和你爸等着抱孙子。”林夏身体前倾，神情由呆滞转为慌乱。',
  ].join('\n'),
  4: [
    '0~4s：林夏正面近景，急忙对电话说：“喂喂喂！怎么就抱孙子都来了？这不对吧？”电话随即传来忙音。',
    '4~7s：手机屏幕特写，父亲又转来五千元；林夏放下手机，盯着通知发愣。仅允许手机中的剧情通知，不生成字幕。',
    '7~12s：林夏中景，低声嘀咕：“好好恋爱可还行？大学不应该好好学习吗？”他深吸一口气站起：“事已至此，先吃饭吧。”随后收起手机走向宿舍楼。',
  ].join('\n'),
  5: [
    '0~5s：206宿舍内中景，林夏推开门，看见陈浩和吕嘉豪把陆野按在地上，愣了一下：“我走错地了？还是咱们宿舍见面要先打一架？”',
    '5~9s：陆野近景，他挣扎着抬头看向门口，大喊：“夏哥救我！他们要杀了我！”陈浩和吕嘉豪仍按着他。',
  ].join('\n'),
  6: [
    '0~4s：四人中景，林夏刚要上前，吕嘉豪回头说：“哥们快来帮忙，拿到陆野手机，我们一起看他和前女友说的情话。”林夏脚步停住。',
    '4~9s：林夏收回迈出的腿，嘴角带笑：“其实我也挺想看的，而且我知道陆野手机密码。”陆野在地上瞪大眼睛。',
  ].join('\n'),
  7: [
    '0~3s：陆野近景，他又急又怒地喊：“我超威！你们干嘛呢！干嘛呢！”',
    '3~7s：宿舍中景，林夏从陆野口袋拿出手机并解锁；陈浩和吕嘉豪立刻凑近屏幕，陆野仍在旁边挣扎。',
    '7~12s：四人中近景，陈浩故意发嗲念：“宝宝，要抱抱。”林夏咬唇憋笑：“老陈，看看就行，别念出来，太伤小野子的心了。”',
  ].join('\n'),
  8: [
    '0~6s：陈浩与陆野双人中近景，陈浩笑着解释：“他自己说谈过，还在我面前秀，我当然要学学恋爱大师的技巧。”陆野气得脸色涨红。',
    '6~9s：陈浩又夹着嗓子说：“要抱抱。”林夏和吕嘉豪在一旁忍笑。',
    '9~12s：陆野突然挣开并扑向陈浩，大喊：“你去死吧！”陈浩迅速后退躲开，林夏仍握着手机。',
  ].join('\n'),
  9: [
    '0~4s：206宿舍内四人中景，吕嘉豪悠闲地靠坐着说：“其实谈恋爱也没什么，我都谈腻了。”',
    '4~6s：陈浩停下打闹，转头问：“所以老吕你也谈过？”',
    '6~9s：吕嘉豪轻描淡写地回答：“当然，高中就谈腻了，现在没兴趣。”陈浩露出惊讶神情。',
  ].join('\n'),
  10: [
    '0~5s：宿舍四人中景，吕嘉豪仍神态悠闲；陈浩看了他片刻，随后把视线转向林夏。',
    '5~10s：陈浩与林夏双人中近景，陈浩好奇地问：“夏哥，你呢？你不会也谈过吧？”',
    '10~15s：林夏走到书桌旁，放下书包并取出笔记本电脑，平静地看向陈浩；陆野、吕嘉豪和陈浩都等着他的回答。',
  ].join('\n'),
  11: [
    '0~4s：林夏中近景，他把笔记本电脑放在桌上，淡淡回答：“我？我母胎单身至今。”',
    '4~8s：陈浩松了口气，目光落到桌上的红本子：“那就好。话说你那红本子是什么？”',
    '8~12s：林夏低头打开电脑，平静回答：“国家发的证书，一个身份证明而已。”陈浩仍好奇地看着红本子。',
  ].join('\n'),
  12: [
    '0~3s：206宿舍内双人中近景，陈浩似懂非懂地点头：“嗦得死内。”林夏继续整理桌面。',
    '3~6s：宿舍门口跟拍中景，林夏、陆野、陈浩和吕嘉豪依次走出宿舍，穿过走廊。',
    '6~10s：切到校园道路全景，四人并肩朝食堂方向走去，步伐自然一致。',
  ].join('\n'),
  13: [
    '0~5s：校园道路侧面跟拍，陈浩凑近林夏低声问：“夏哥，你真没谈过？”林夏看向他：“骗你干嘛。”',
    '5~10s：四人继续前行，陆野揉着胳膊，愤愤地说：“你们等着，这事没完。”',
    '10~15s：吕嘉豪轻拍陆野肩膀，笑着安慰：“小野子，别气了，哥请你吃饭。”陆野神情稍微缓和。',
  ].join('\n'),
  14: [
    '0~4s：校园道路跟拍中景，四人继续走向食堂；林夏望着前方，嘴角微微扬起，手机铃声突然响起。',
    '4~8s：林夏停步看清来电，接起手机，语气无奈：“妈，又怎么了？”另外三人在前方放慢脚步等他。',
    '8~15s：林夏走到路边，林夏母亲仅以电话画外音兴奋地问：“小夏！你真的和人结婚了？谁啊？小姑娘漂不漂亮？”林夏压低声音，回头看了一眼同伴。',
  ].join('\n'),
  15: [
    '0~5s：林夏侧面近景，他站在校园道路旁，手机贴耳，低声回答：“真的，很漂亮，你放心，我丑的也不会要的。”',
    '5~8s：林夏过肩近景，他拉开背包，看见里面的红本子，紧张神情逐渐放松。',
    '8~15s：林夏看着红本子，带着笑意低声自语：“洛雪微确实漂亮。再来一次我还是会亲她，反正证都领了。”',
  ].join('\n'),
  16: '0~3s：林夏中近景，他合上背包，抬头看向食堂方向，神情坚定又轻松，随后迈步追上室友。无对白。',
}

const legacySoundRules = [
  /不要背景音乐，保留现场对白、环境声和必要音效。/gu,
  /不要生成背景音乐（BGM），保留现场对白，允许环境声和必要音效。/gu,
  /不要生成背景音乐（BGM），允许并保留符合动作和场景的必要音效。/gu,
]

function replaceTimeline(videoPrompt: string, timeline: string) {
  const heading = /^【视频分镜】\s*$/mu.exec(videoPrompt)
  if (!heading) throw new Error('分镜缺少【视频分镜】段落')
  const timelineStart = heading.index + heading[0].length
  return `${videoPrompt.slice(0, timelineStart)}\n${timeline}`
}

function ensureSingleSoundRule(videoPrompt: string) {
  let nextPrompt = videoPrompt
  for (const legacyRule of legacySoundRules) {
    nextPrompt = nextPrompt.replace(legacyRule, '')
  }

  const animationMarker = '人物自然眨眼'
  if (nextPrompt.includes(animationMarker)) {
    return nextPrompt.replace(animationMarker, `${soundRule}${animationMarker}`)
  }

  const peopleHeading = '\n\n【人物及初始站位】'
  if (!nextPrompt.includes(peopleHeading)) {
    throw new Error('分镜缺少【人物及初始站位】段落')
  }
  return nextPrompt.replace(peopleHeading, `\n${soundRule}${peopleHeading}`)
}

function assertTimeline(number: number, duration: number, timeline: string) {
  for (const label of ['动作顺序：', '动作物理：', '表演变化：', '本段结束状态：', '优先读取情绪反应', '按对白顺序自然同步口型']) {
    if (timeline.includes(label)) throw new Error(`分镜 ${number} 仍包含内部标签：${label}`)
  }

  const ranges = [...timeline.matchAll(/(\d+)~(\d+)s：/gu)]
  if (ranges.length === 0) throw new Error(`分镜 ${number} 缺少时间段`)
  const finalEnd = Number(ranges.at(-1)?.[2])
  if (finalEnd !== duration) {
    throw new Error(`分镜 ${number} 时间轴结束于 ${finalEnd}s，实际时长为 ${duration}s`)
  }
}

const episode = await prisma.scriptEpisode.findUniqueOrThrow({
  where: { projectId_episodeNumber: { projectId, episodeNumber: 3 } },
  select: {
    title: true,
    content: true,
    storyboards: {
      orderBy: [{ episodeSceneNumber: 'asc' }, { sceneNumber: 'asc' }],
      select: {
        id: true,
        episodeSceneNumber: true,
        title: true,
        duration: true,
        videoPrompt: true,
        selectedVideoId: true,
        _count: { select: { videos: true } },
      },
    },
  },
})

if (episode.title !== '家里不穷了' || episode.storyboards.length !== 16) {
  throw new Error(`目标集不匹配：${episode.title}，${episode.storyboards.length} 条分镜`)
}
for (const evidence of ['其实是别人欠我们家的', '我超威！你们干嘛呢！干嘛呢！', '嗦得死内', '反正都领证了，不亲白不亲']) {
  if (!episode.content.includes(evidence)) throw new Error(`锁定剧本缺少核对依据：${evidence}`)
}

const changes = episode.storyboards.map((storyboard) => {
  const number = storyboard.episodeSceneNumber || 0
  const timeline = timelines[number]
  if (!timeline) throw new Error(`缺少分镜 ${number} 的短版时间轴`)
  assertTimeline(number, storyboard.duration, timeline)

  const currentPrompt = storyboard.videoPrompt || ''
  const nextPrompt = ensureSingleSoundRule(replaceTimeline(currentPrompt, timeline))
  const soundRuleCount = nextPrompt.split(soundRule).length - 1
  if (soundRuleCount !== 1) {
    throw new Error(`分镜 ${number} 的 BGM 规则数量为 ${soundRuleCount}`)
  }

  return { storyboard, timeline, currentPrompt, nextPrompt }
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
  episode: 3,
  title: episode.title,
  applied: apply,
  changed: changes.filter(({ currentPrompt, nextPrompt }) => currentPrompt !== nextPrompt).length,
  preservedVideos: changes.reduce((total, { storyboard }) => total + storyboard._count.videos, 0),
  selectedVideos: changes.filter(({ storyboard }) => storyboard.selectedVideoId).length,
  storyboards: changes.map(({ storyboard, currentPrompt, nextPrompt, timeline }) => ({
    number: storyboard.episodeSceneNumber,
    title: storyboard.title,
    duration: storyboard.duration,
    before: currentPrompt.length,
    after: nextPrompt.length,
    videos: storyboard._count.videos,
    selected: Boolean(storyboard.selectedVideoId),
    soundRuleCount: nextPrompt.split(soundRule).length - 1,
    timeline,
  })),
}, null, 2))

await prisma.$disconnect()
