import { prisma } from '../src/lib/db'
import { extractScriptDialogueLines } from '../src/lib/preproduction-prompts'

const episodes = await prisma.scriptEpisode.findMany({
  where: { locked: true },
  orderBy: { episodeNumber: 'asc' },
})
console.log(JSON.stringify(episodes.map((episode) => {
  const dialogues = extractScriptDialogueLines(episode.content)
  return {
    episodeNumber: episode.episodeNumber,
    sourceChars: episode.content.length,
    dialogueTurns: dialogues.length,
    dialogueChars: dialogues.reduce((total, dialogue) => total + dialogue.text.length, 0),
  }
}), null, 2))
await prisma.$disconnect()
