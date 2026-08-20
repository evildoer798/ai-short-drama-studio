export type CompletedScreenplayEpisode = {
  episodeNumber: number
  title: string
  content: string
}

export type CompletedScreenplay = {
  episodes: CompletedScreenplayEpisode[]
}

const EPISODE_HEADING = /^(?:#{1,6}\s*)?第\s*(\d{1,3})\s*集\s*[：:]\s*(.+?)\s*$/gmu
const SCENE_HEADING = /^(?:#{1,6}\s*)?(?:【?场(?:次)?\s*\d+(?:[-－—.]\d+)?[^\n】]*】?|场\s*\d+(?:[-－—.]\d+)?\b)/mu

/**
 * Detects an already-written episodic screenplay. Its episode bodies are source
 * material, not prose to be redrafted by the adaptation model.
 */
export function parseCompletedScreenplay(value: string): CompletedScreenplay | null {
  const source = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const matches = [...source.matchAll(EPISODE_HEADING)]
  if (matches.length < 2) return null

  const episodes = matches.map((match, index) => {
    const episodeNumber = Number(match[1])
    const title = match[2].trim()
    const bodyStart = (match.index || 0) + match[0].length
    const bodyEnd = matches[index + 1]?.index ?? source.length
    return {
      episodeNumber,
      title,
      content: source.slice(bodyStart, bodyEnd).trim(),
    }
  })

  const sequential = episodes.every((episode, index) => episode.episodeNumber === index + 1)
  const complete = episodes.every((episode) => (
    episode.title.length > 0
    && episode.content.length > 0
    && SCENE_HEADING.test(episode.content)
  ))
  if (!sequential || !complete) return null

  return { episodes }
}
