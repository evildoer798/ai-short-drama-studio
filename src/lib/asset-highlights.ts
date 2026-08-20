export type AssetHighlightType = 'character' | 'location' | 'prop'

export type HighlightableAsset = {
  id: string
  name: string
  type: AssetHighlightType
  referenceOrder: number
  highlightTerms: string[]
}

export type AssetHighlightSegment = {
  text: string
  assetId?: string
  assetName?: string
  assetType?: AssetHighlightType
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function promptSectionRange(
  text: string,
  headings: string[],
): { start: number; end: number } | null {
  const headingPattern = new RegExp(`【(?:${headings.map(escapeRegExp).join('|')})】`, 'u')
  const heading = headingPattern.exec(text)
  if (!heading || heading.index === undefined) return null
  const start = heading.index + heading[0].length
  const nextHeading = text.slice(start).search(/【[^】\n]+】/u)
  return {
    start,
    end: nextHeading >= 0 ? start + nextHeading : text.length,
  }
}

export function splitAssetHighlights(
  text: string,
  assets: HighlightableAsset[],
): AssetHighlightSegment[] {
  const owners = new Map<string, HighlightableAsset>()
  for (const asset of assets) {
    const terms = [
      asset.name,
      ...(asset.type === 'prop' ? [] : asset.highlightTerms),
      `@image${asset.referenceOrder}`,
      `@${asset.referenceOrder}`,
    ]
    for (const rawTerm of terms) {
      const term = rawTerm.trim()
      if (term.length < 2) continue
      const key = term.toLocaleLowerCase()
      if (!owners.has(key)) owners.set(key, asset)
    }
  }

  const terms = [...owners.keys()].sort((left, right) => right.length - left.length)
  if (!text || terms.length === 0) return [{ text }]

  const characterRange = promptSectionRange(text, ['本分镜人物', '人物及初始站位', '人物及站位'])
  const locationRange = promptSectionRange(text, ['场景'])
  const matcher = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'giu')
  let cursor = 0
  return text.split(matcher).filter(Boolean).map((part) => {
    const start = cursor
    cursor += part.length
    const asset = owners.get(part.toLocaleLowerCase())
    const allowedRange = asset?.type === 'character'
      ? characterRange
      : asset?.type === 'location' || asset?.type === 'prop'
        ? locationRange
        : null
    const isInsideAllowedSection = Boolean(
      allowedRange
      && start >= allowedRange.start
      && start + part.length <= allowedRange.end,
    )
    return asset && isInsideAllowedSection
      ? {
          text: part,
          assetId: asset.id,
          assetName: asset.name,
          assetType: asset.type,
        }
      : { text: part }
  })
}
