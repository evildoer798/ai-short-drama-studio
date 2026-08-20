export type FinalStoryboardDialogueDocument = {
  id: string
  number: number
  title: string
  videoPrompt: string
}

export type FinalStoryboardDialogueIssue = {
  kind: 'exact_duplicate' | 'overlap_duplicate'
  shotNumbers: number[]
  text: string
  otherText: string
  message: string
}

type DialogueOccurrence = {
  documentIndex: number
  shotNumber: number
  text: string
  key: string
  quoteStart: number
  quoteEnd: number
}

export function normalizeFinalStoryboardDialogue(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '')
}

function scriptDialogueCounts(script: string) {
  const counts = new Map<string, number>()
  for (const line of script.replace(/\r\n/g, '\n').split('\n')) {
    const match = line.trim().match(/^[^：:\n]{1,40}[：:]\s*(.+)$/u)
    if (!match) continue
    const key = normalizeFinalStoryboardDialogue(match[1])
    if (key.length < 4) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function promptDialogueOccurrences(
  documents: FinalStoryboardDialogueDocument[],
) {
  return documents.flatMap((document, documentIndex) => {
    const timelineHeading = document.videoPrompt.indexOf('【视频分镜】')
    const timelineOffset = timelineHeading >= 0
      ? timelineHeading + '【视频分镜】'.length
      : 0
    const timeline = document.videoPrompt.slice(timelineOffset)
    return [...timeline.matchAll(/[“"]([^”"\n]{2,})[”"]/gu)].flatMap((match) => {
      const text = match[1].trim()
      const key = normalizeFinalStoryboardDialogue(text)
      if (key.length < 6 || match.index === undefined) return []
      const quoteStart = timelineOffset + match.index
      return [{
        documentIndex,
        shotNumber: document.number,
        text,
        key,
        quoteStart,
        quoteEnd: quoteStart + match[0].length,
      }]
    })
  })
}

function sourceAllowsDuplicate(
  sourceCounts: Map<string, number>,
  left: DialogueOccurrence,
  right: DialogueOccurrence,
) {
  if (left.key !== right.key) return false
  return (sourceCounts.get(left.key) || 0) > 1
}

export function validateFinalStoryboardDialogue(
  documents: FinalStoryboardDialogueDocument[],
  script: string,
) {
  const sourceCounts = scriptDialogueCounts(script)
  const occurrences = promptDialogueOccurrences(documents)
  const issues: FinalStoryboardDialogueIssue[] = []
  const seen = new Set<string>()
  for (let leftIndex = 0; leftIndex < occurrences.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < occurrences.length; rightIndex += 1) {
      const left = occurrences[leftIndex]
      const right = occurrences[rightIndex]
      if (sourceAllowsDuplicate(sourceCounts, left, right)) continue
      const exact = left.key === right.key
      const overlap = !exact
        && Math.min(left.key.length, right.key.length) >= 6
        && (left.key.includes(right.key) || right.key.includes(left.key))
      if (!exact && !overlap) continue
      const key = `${exact ? 'exact' : 'overlap'}:${left.shotNumber}:${right.shotNumber}:${left.key}:${right.key}`
      if (seen.has(key)) continue
      seen.add(key)
      const shotNumbers = [...new Set([left.shotNumber, right.shotNumber])]
      issues.push({
        kind: exact ? 'exact_duplicate' : 'overlap_duplicate',
        shotNumbers,
        text: left.text,
        otherText: right.text,
        message: `${shotNumbers.map((number) => `分镜${number}`).join('与')}重复对白“${right.text}”`,
      })
    }
  }
  return issues
}

function removeQuotedClause(prompt: string, occurrence: DialogueOccurrence) {
  const lineStart = prompt.lastIndexOf('\n', occurrence.quoteStart) + 1
  const lineEndCandidate = prompt.indexOf('\n', occurrence.quoteEnd)
  const lineEnd = lineEndCandidate < 0 ? prompt.length : lineEndCandidate
  const previousSeparator = prompt.lastIndexOf('；', occurrence.quoteStart)
  const nextSeparator = prompt.indexOf('；', occurrence.quoteEnd)
  if (previousSeparator >= lineStart && nextSeparator >= 0 && nextSeparator <= lineEnd) {
    return `${prompt.slice(0, previousSeparator)}${prompt.slice(nextSeparator)}`
  }
  const quote = prompt.slice(occurrence.quoteStart, occurrence.quoteEnd)
  return prompt.replace(quote, '无重复对白')
}

export function repairExactFinalStoryboardDialogueDuplicates(
  documents: FinalStoryboardDialogueDocument[],
  script: string,
) {
  const sourceCounts = scriptDialogueCounts(script)
  const mutable = documents.map((document) => ({ ...document }))
  const occurrences = promptDialogueOccurrences(mutable)
  const seenCounts = new Map<string, number>()
  const removals = new Map<number, DialogueOccurrence[]>()
  for (const occurrence of occurrences) {
    const count = seenCounts.get(occurrence.key) || 0
    const allowed = sourceCounts.get(occurrence.key) || 1
    if (count >= allowed) {
      const current = removals.get(occurrence.documentIndex) || []
      current.push(occurrence)
      removals.set(occurrence.documentIndex, current)
    } else {
      seenCounts.set(occurrence.key, count + 1)
    }
  }
  for (const [documentIndex, documentRemovals] of removals) {
    for (const occurrence of [...documentRemovals].sort((left, right) => right.quoteStart - left.quoteStart)) {
      mutable[documentIndex].videoPrompt = removeQuotedClause(mutable[documentIndex].videoPrompt, occurrence)
    }
  }
  return {
    documents: mutable,
    changedDocumentIds: [...removals.keys()].map((index) => mutable[index].id),
    issues: validateFinalStoryboardDialogue(mutable, script),
  }
}
