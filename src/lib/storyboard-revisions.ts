import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

export const storyboardRevisionSnapshotSchema = z.object({
  title: z.string(),
  notes: z.string().nullable(),
  imagePrompt: z.string().nullable(),
  directorPrompt: z.string().nullable().default(null),
  videoPrompt: z.string().nullable(),
  duration: z.number().int(),
  aspectRatio: z.string(),
  generateAudio: z.boolean(),
  continuityIn: z.unknown().nullable(),
  continuityOut: z.unknown().nullable(),
})

export type StoryboardRevisionSnapshot = z.output<typeof storyboardRevisionSnapshotSchema>

type SnapshotSource = {
  title: string
  notes: string | null
  imagePrompt: string | null
  directorPrompt?: string | null
  videoPrompt: string | null
  duration: number
  aspectRatio: string
  generateAudio: boolean
  continuityIn: unknown | null
  continuityOut: unknown | null
}

type RevisionStoryboard = SnapshotSource & {
  id: string
  projectId: string
  episodeId: string | null
  episodeSceneNumber: number | null
  sceneNumber: number
}

export function storyboardRevisionSnapshot(storyboard: SnapshotSource): StoryboardRevisionSnapshot {
  return storyboardRevisionSnapshotSchema.parse({
    title: storyboard.title,
    notes: storyboard.notes,
    imagePrompt: storyboard.imagePrompt,
    directorPrompt: storyboard.directorPrompt ?? null,
    videoPrompt: storyboard.videoPrompt,
    duration: storyboard.duration,
    aspectRatio: storyboard.aspectRatio,
    generateAudio: storyboard.generateAudio,
    continuityIn: storyboard.continuityIn ?? null,
    continuityOut: storyboard.continuityOut ?? null,
  })
}

export function storyboardRevisionContentHash(snapshot: StoryboardRevisionSnapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

export async function createStoryboardRevision(
  tx: Pick<Prisma.TransactionClient, 'storyboardRevision'>,
  storyboard: RevisionStoryboard,
  input: {
    source: string
    reason?: string | null
    sourceTaskId?: string | null
    createdById?: string | null
    validationReport?: Prisma.InputJsonValue | null
  },
) {
  const snapshot = storyboardRevisionSnapshot(storyboard)
  return tx.storyboardRevision.create({
    data: {
      projectId: storyboard.projectId,
      episodeId: storyboard.episodeId,
      storyboardId: storyboard.id,
      episodeSceneNumber: storyboard.episodeSceneNumber,
      sceneNumber: storyboard.sceneNumber,
      source: input.source,
      reason: input.reason || null,
      sourceTaskId: input.sourceTaskId || null,
      createdById: input.createdById || null,
      snapshot: snapshot as Prisma.InputJsonValue,
      contentHash: storyboardRevisionContentHash(snapshot),
      validationReport: input.validationReport ?? Prisma.JsonNull,
    },
  })
}

export function storyboardRevisionRestoreData(snapshotValue: unknown) {
  const snapshot = storyboardRevisionSnapshotSchema.parse(snapshotValue)
  return {
    title: snapshot.title,
    notes: snapshot.notes,
    imagePrompt: snapshot.imagePrompt,
    directorPrompt: snapshot.directorPrompt,
    videoPrompt: snapshot.videoPrompt,
    duration: snapshot.duration,
    aspectRatio: snapshot.aspectRatio,
    generateAudio: snapshot.generateAudio,
    continuityIn: snapshot.continuityIn === null
      ? Prisma.JsonNull
      : snapshot.continuityIn as Prisma.InputJsonValue,
    continuityOut: snapshot.continuityOut === null
      ? Prisma.JsonNull
      : snapshot.continuityOut as Prisma.InputJsonValue,
  }
}
