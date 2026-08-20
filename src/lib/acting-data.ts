import { prisma } from './db'
import type { CompilableShotPerformance, PerformanceBeatInput } from './acting-system'

export function serializeCharacterActingProfile(profile: {
  id: string
  assetId: string
  masterPrompt: string
  physicality: string
  psychologicalEngine: string
  vocalBehavior: string
  signatureTics: unknown
  stressTics: unknown
  concealmentBehavior: string | null
  facialMask: string | null
  maskCrackTrigger: string | null
  pressureTransformation: string | null
  gait: string | null
  eyeLife: string
  softeningTarget: string | null
  version: number
  updatedAt: Date
} | null) {
  if (!profile) return null
  return {
    ...profile,
    signatureTics: Array.isArray(profile.signatureTics) ? profile.signatureTics : [],
    stressTics: Array.isArray(profile.stressTics) ? profile.stressTics : [],
    updatedAt: profile.updatedAt.toISOString(),
  }
}

export function serializeVoiceProfile(profile: {
  id: string
  assetId: string
  prompt: string
  ageDescriptor: string | null
  originAccent: string | null
  timbreRegister: string | null
  paceDelivery: string | null
  pressureShift: string | null
  locked: boolean
  version: number
  updatedAt: Date
} | null) {
  if (!profile) return null
  return { ...profile, updatedAt: profile.updatedAt.toISOString() }
}

export async function getStoryboardPerformances(storyboardId: string) {
  const performances = await prisma.shotPerformance.findMany({
    where: { storyboardId },
    include: {
      asset: { select: { id: true, name: true, type: true } },
      actingProfile: true,
      voiceProfile: true,
      beats: { orderBy: { order: 'asc' } },
    },
    orderBy: { asset: { name: 'asc' } },
  })

  return performances.map((performance) => ({
    id: performance.id,
    storyboardId: performance.storyboardId,
    assetId: performance.assetId,
    assetName: performance.asset.name,
    objective: performance.objective,
    obstacle: performance.obstacle,
    stakes: performance.stakes,
    subtext: performance.subtext,
    business: performance.business,
    statusIn: performance.statusIn,
    statusOut: performance.statusOut,
    proximityIn: performance.proximityIn,
    proximityOut: performance.proximityOut,
    sceneAdaptation: performance.sceneAdaptation,
    speaks: performance.speaks,
    qualityScore: performance.qualityScore,
    qualityReport: performance.qualityReport,
    updatedAt: performance.updatedAt.toISOString(),
    actingProfile: serializeCharacterActingProfile(performance.actingProfile),
    voiceProfile: serializeVoiceProfile(performance.voiceProfile),
    beats: performance.beats.map((beat) => ({
      id: beat.id,
      order: beat.order,
      startSeconds: beat.startSeconds,
      endSeconds: beat.endSeconds,
      tactic: beat.tactic,
      trigger: beat.trigger,
      behavior: beat.behavior,
      reaction: beat.reaction,
      gaze: beat.gaze,
      posture: beat.posture,
      tempo: beat.tempo,
      voiceDelivery: beat.voiceDelivery,
      entryState: beat.entryState,
      exitState: beat.exitState,
    })),
  }))
}

export async function getCompilableStoryboardPerformances(
  storyboardId: string,
  referenceOrderByAssetId: Map<string, number> = new Map(),
): Promise<CompilableShotPerformance[]> {
  const performances = await getStoryboardPerformances(storyboardId)
  return performances.map((performance) => ({
    assetId: performance.assetId,
    assetName: performance.assetName,
    referenceOrder: referenceOrderByAssetId.get(performance.assetId),
    objective: performance.objective,
    obstacle: performance.obstacle,
    stakes: performance.stakes,
    subtext: performance.subtext,
    business: performance.business,
    statusIn: performance.statusIn,
    statusOut: performance.statusOut,
    proximityIn: performance.proximityIn,
    proximityOut: performance.proximityOut,
    sceneAdaptation: performance.sceneAdaptation,
    speaks: performance.speaks,
    beats: performance.beats as PerformanceBeatInput[],
    actingProfile: performance.actingProfile,
    voiceProfile: performance.voiceProfile,
  }))
}
