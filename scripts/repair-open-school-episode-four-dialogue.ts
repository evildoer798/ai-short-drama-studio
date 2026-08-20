import { prisma } from '../src/lib/db'
import {
  validateFinalStoryboardDialogue,
  type FinalStoryboardDialogueDocument,
} from '../src/lib/storyboard-dialogue-validation'
import { createStoryboardRevision } from '../src/lib/storyboard-revisions'
import { syncStoryboardAssetLinks } from '../src/lib/storyboards'

const projectId = process.argv[2]?.trim() || 'cmsd39w7g0001mx3qmwcibd36'
const dryRun = process.argv.includes('--dry-run')

function replaceTimeline(prompt: string, timeline: string) {
  const marker = '【视频分镜】'
  const markerIndex = prompt.indexOf(marker)
  if (markerIndex < 0) throw new Error('Storyboard prompt is missing the timeline heading')
  return `${prompt.slice(0, markerIndex + marker.length)}\n${timeline.trim()}`
}

const replacementTimelines = new Map<number, string>([
  [7, `0~4s：双人中近景，固定机位。陈浩听完后意外地愣住，嘴唇微张：“这……”林夏保持清晰侧脸，脚步放慢。
4~14s：林夏近景，固定机位。林夏目光微垂，嘴角扯出一丝自嘲：“我这不是备胎是什么？三年感情喂了狗，及时止损。”说完微微摇头，眼神由黯淡转为清醒。`],
  [8, `0~7s：中景，固定机位。吕嘉豪从林夏左侧接话，一副过来人姿态：“老夏你就该坚持坚持，人家都说了，”林夏侧目看他，神情冷淡。
7~15s：林夏与吕嘉豪双人中近景，固定机位。吕嘉豪继续：“等一段时间，坚持一下肯定会同意的。”林夏收回视线，嘴角微沉，继续向前走。`],
  [18, `0~5s：吕嘉豪近景，固定机位。吕嘉豪还没理解陈浩的意思，疑惑地顺着他手指的方向看去，没有说话。
5~11s：中景，从吕嘉豪肩后拍陈浩。陈浩指向走廊前方，急着解释：“不是！我是说前面那个走过来又白又长的美女。”吕嘉豪立即顺着手指方向看去。`],
  [19, `0~5s：中景，固定机位。吕嘉豪和陆野同时看向走廊远处走来的白色身影，陈浩保持指向前方的姿势。无对白。
5~10s：吕嘉豪中近景，固定机位。他看清后眼神一亮：“确实又白又长的。”
10~14s：陆野近景，他点头回应：“嗯。”随后视线越过吕嘉豪看向林夏，眼神变得微妙。`],
  [20, `0~4s：近景，从陈浩肩后拍吕嘉豪。吕嘉豪看着白色身影越走越近，声音发虚：“好像是的……”
4~10s：中近景，林夏站在三人后方低头看手机，假装没有注意走近的人；陆野和吕嘉豪仍看向前方。无对白。
10~15s：陈浩近景，固定机位。他眼神发亮，看着对方朝四人走来：“这个美女好像在朝我们走来诶！”吕嘉豪紧张地绷住表情。`],
])

try {
  const episode = await prisma.scriptEpisode.findUniqueOrThrow({
    where: { projectId_episodeNumber: { projectId, episodeNumber: 4 } },
    include: {
      storyboards: { orderBy: { episodeSceneNumber: 'asc' } },
    },
  })
  const proposedPrompts = new Map(episode.storyboards.map((storyboard) => {
    const replacement = replacementTimelines.get(storyboard.episodeSceneNumber || -1)
    return [storyboard.id, replacement
      ? replaceTimeline(storyboard.videoPrompt || '', replacement)
      : storyboard.videoPrompt || ''] as const
  }))
  const documents: FinalStoryboardDialogueDocument[] = episode.storyboards.map((storyboard) => ({
    id: storyboard.id,
    number: storyboard.episodeSceneNumber || storyboard.sceneNumber,
    title: storyboard.title,
    videoPrompt: proposedPrompts.get(storyboard.id) || '',
  }))
  const issues = validateFinalStoryboardDialogue(documents, episode.content)
  if (issues.length > 0) {
    throw new Error(`Repair still contains duplicate dialogue: ${JSON.stringify(issues)}`)
  }
  const targets = episode.storyboards.filter((storyboard) => (
    replacementTimelines.has(storyboard.episodeSceneNumber || -1)
  ))
  if (!dryRun) {
    await prisma.$transaction(async (tx) => {
      for (const storyboard of targets) {
        await createStoryboardRevision(tx, storyboard, {
          source: 'production_dialogue_repair',
          reason: '修复第4集相邻分镜重复台词与说话人错位',
          validationReport: { finalDialogueIssuesBefore: 'detected', finalDialogueIssuesAfter: [] },
        })
        await tx.storyboard.update({
          where: { id: storyboard.id },
          data: { videoPrompt: proposedPrompts.get(storyboard.id) },
        })
      }
    })
    await Promise.all(targets.map((storyboard) => syncStoryboardAssetLinks(storyboard.id)))
  }
  console.log(JSON.stringify({
    dryRun,
    updatedShots: targets.map((storyboard) => storyboard.episodeSceneNumber),
    remainingIssues: issues,
  }))
} finally {
  await prisma.$disconnect()
}
