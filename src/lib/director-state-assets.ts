import { Prisma } from '@prisma/client'
import { prisma } from './db'
import {
  actingStageOutputSchema,
  liraStageOutputSchema,
  type LiraStageOutput,
} from './director-system'

const identityMasterPrefix = '__identity__:'

export function identityMasterStateId(assetId: string) {
  return `${identityMasterPrefix}${assetId}`
}

export function isIdentityMasterStateId(stateId: string) {
  return stateId.startsWith(identityMasterPrefix)
}

export function identityMasterPromptFor(
  assetName: string,
  states: LiraStageOutput['characterStates'],
) {
  const anchors = [...new Set(states.flatMap((state) => state.identityAnchors))].slice(0, 12)
  const baseline = states[0]
  return [
    `Create the canonical initial character identity reference for ${assetName}.`,
    anchors.length ? `Immutable identity anchors: ${anchors.join('; ')}.` : '',
    baseline?.wardrobe ? `Baseline wardrobe: ${baseline.wardrobe}.` : '',
    baseline?.hairMakeup ? `Baseline hair and makeup: ${baseline.hairMakeup}.` : '',
    'Neutral standing pose, calm neutral expression, full face and full body clearly visible, clean simple studio background.',
    'No injuries, dirt, tears, transformation, action pose, dramatic emotion, temporary costume damage, text, watermark, or extra people.',
    'This image is the identity master for every later appearance of this character. Prioritize stable facial geometry, body proportions, age, skin tone, hairline, and distinctive features.',
  ].filter(Boolean).join(' ')
}

export function identityMasterVersionIdFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = Reflect.get(payload, 'identityMasterVersionId')
  return typeof value === 'string' && value ? value : null
}

export async function syncDirectorCharacterStateAssets(
  productionId: string,
  output: unknown,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const lira = liraStageOutputSchema.parse(output)
  const actingRow = await client.directorStageVersion.findFirst({
    where: { productionId, stage: 'acting', status: 'confirmed', output: { not: Prisma.DbNull } },
    orderBy: { version: 'desc' },
    select: { output: true },
  })
  const acting = actingRow?.output ? actingStageOutputSchema.parse(actingRow.output) : null
  const statesByAsset = new Map<string, LiraStageOutput['characterStates']>()
  for (const state of lira.characterStates) {
    const states = statesByAsset.get(state.assetId) || []
    states.push(state)
    statesByAsset.set(state.assetId, states)
  }
  for (const profile of acting?.characterProfiles || []) {
    if (!statesByAsset.has(profile.assetId)) statesByAsset.set(profile.assetId, [])
  }
  for (const [assetId, states] of statesByAsset) {
    const actingProfile = acting?.characterProfiles.find((profile) => profile.assetId === assetId)
    const first = states[0]
    const assetName = first?.assetName || actingProfile?.assetName || assetId
    const prompt = [
      identityMasterPromptFor(assetName, states),
      actingProfile?.masterPrompt ? `Character performance identity: ${actingProfile.masterPrompt}` : '',
    ].filter(Boolean).join(' ')
    await client.directorCharacterStateAsset.upsert({
      where: { productionId_stateId: { productionId, stateId: identityMasterStateId(assetId) } },
      create: {
        productionId,
        stateId: identityMasterStateId(assetId),
        assetId,
        assetName,
        stateName: '初始形象 · 身份母版',
        prompt,
        imageModelRoute: first?.imageModelRoute || 'gpt-image-2',
        soulIdRequired: false,
      },
      update: {
        assetName,
        stateName: '初始形象 · 身份母版',
        prompt,
        imageModelRoute: first?.imageModelRoute || 'gpt-image-2',
        soulIdRequired: false,
      },
    })
  }
  for (const state of lira.characterStates) {
    await client.directorCharacterStateAsset.upsert({
      where: { productionId_stateId: { productionId, stateId: state.stateId } },
      create: {
        productionId,
        stateId: state.stateId,
        assetId: state.assetId,
        assetName: state.assetName,
        stateName: state.stateName,
        prompt: state.prompt,
        imageModelRoute: state.imageModelRoute,
        soulIdRequired: state.soulIdRequired,
      },
      update: {
        assetId: state.assetId,
        assetName: state.assetName,
        stateName: state.stateName,
        prompt: state.prompt,
        imageModelRoute: state.imageModelRoute,
        soulIdRequired: state.soulIdRequired,
      },
    })
  }
  return lira
}

export function stateIdsForShot(lira: LiraStageOutput | null, shotKey: string) {
  return lira?.keyframes.find((frame) => frame.shotKey === shotKey)?.characterStateIds || []
}

export function lockedStateMediaIds(
  stateAssets: Array<{ stateId: string; selectedImageVersion?: { mediaId: string } | null }>,
  stateIds?: string[],
) {
  const allowed = stateIds?.length ? new Set(stateIds) : null
  return stateAssets.flatMap((asset) => (
    (!allowed || allowed.has(asset.stateId)) && asset.selectedImageVersion?.mediaId
      ? [asset.selectedImageVersion.mediaId]
      : []
  ))
}

export function unresolvedStateAssetIds(
  stateAssets: Array<{ stateId: string; selectedImageVersionId: string | null }>,
) {
  return stateAssets.filter((asset) => !asset.selectedImageVersionId).map((asset) => asset.stateId)
}
