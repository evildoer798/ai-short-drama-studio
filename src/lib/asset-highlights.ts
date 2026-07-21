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

export function splitAssetHighlights(
  text: string,
  assets: HighlightableAsset[],
): AssetHighlightSegment[] {
  const owners = new Map<string, HighlightableAsset>()
  for (const asset of assets) {
    if (asset.type === 'prop') continue
    const terms = [
      asset.name,
      ...asset.highlightTerms,
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

  const matcher = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'giu')
  return text.split(matcher).filter(Boolean).map((part) => {
    const asset = owners.get(part.toLocaleLowerCase())
    return asset
      ? {
          text: part,
          assetId: asset.id,
          assetName: asset.name,
          assetType: asset.type,
        }
      : { text: part }
  })
}
