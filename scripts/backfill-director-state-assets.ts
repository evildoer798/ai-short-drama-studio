import { Prisma } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { syncDirectorCharacterStateAssets } from '../src/lib/director-state-assets'
import { getVideoModelDefinition } from '../src/lib/video-models'
import { selectVideoCapability } from '../src/lib/openai-video'

const productionId = process.argv[2]
if (!productionId) throw new Error('Usage: backfill-director-state-assets.ts <production-id>')

try {
  const lira = await prisma.directorStageVersion.findFirst({
    where: { productionId, stage: 'lira', output: { not: Prisma.DbNull } },
    orderBy: { version: 'desc' },
    select: { output: true },
  })
  if (!lira?.output) throw new Error(`No LIRA output found for production ${productionId}`)
  await syncDirectorCharacterStateAssets(productionId, lira.output)
  const [total, locked] = await Promise.all([
    prisma.directorCharacterStateAsset.count({ where: { productionId } }),
    prisma.directorCharacterStateAsset.count({
      where: { productionId, selectedImageVersionId: { not: null } },
    }),
  ])
  const identityMasters = await prisma.directorCharacterStateAsset.count({
    where: { productionId, stateId: { startsWith: '__identity__:' } },
  })
  const modelId = 'sd7-seedance-2.0-720p'
  const capability = selectVideoCapability([modelId], modelId)
  const definition = getVideoModelDefinition(modelId)
  if (!capability || !definition) throw new Error(`${modelId} capability is unavailable`)
  console.log(JSON.stringify({
    productionId,
    stateAssets: total,
    identityMasters,
    stateVariants: total - identityMasters,
    locked,
    capability,
    definition,
  }))
} finally {
  await prisma.$disconnect()
}
