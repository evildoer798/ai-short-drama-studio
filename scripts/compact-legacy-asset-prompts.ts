import { AssetType } from '@prisma/client'
import { prisma } from '@/lib/db'
import { enforceAssetPrompt } from '@/lib/preproduction-prompts'

const LEGACY_PROMPT_PATTERN = /人物设定图必须以白色背景身份卡呈现|场景必须绝对真空与匿名|道具设定必须精准遵循剧本用途与年代|不能出现其他人\s*[,，]\s*无人\s*[,，]\s*纯场景|no\s+humans\s*[,，]?\s*empty/iu

async function main() {
  const assets = await prisma.asset.findMany({
    where: { prompt: { not: null } },
    include: {
      project: {
        select: {
          visualStyle: true,
          customStylePrompt: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
  const characterNamesByProject = new Map<string, string[]>()
  for (const asset of assets) {
    if (asset.type !== AssetType.character) continue
    const names = characterNamesByProject.get(asset.projectId) || []
    names.push(asset.name)
    characterNamesByProject.set(asset.projectId, names)
  }

  let updated = 0
  let originalCharacters = 0
  let compactedCharacters = 0
  for (const asset of assets) {
    if (!asset.prompt || !LEGACY_PROMPT_PATTERN.test(asset.prompt)) continue
    const enforced = enforceAssetPrompt({
      type: asset.type,
      name: asset.name,
      prompt: asset.prompt,
      characterNames: characterNamesByProject.get(asset.projectId) || [],
      visualStyle: asset.project.visualStyle,
      customStylePrompt: asset.project.customStylePrompt,
      preserveName: true,
    })
    if (enforced.prompt === asset.prompt) continue
    await prisma.asset.update({
      where: { id: asset.id },
      data: { prompt: enforced.prompt },
    })
    updated += 1
    originalCharacters += asset.prompt.length
    compactedCharacters += enforced.prompt.length
  }

  console.log(`ASSET_PROMPTS_COMPACTED updated=${updated} before=${originalCharacters} after=${compactedCharacters}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
