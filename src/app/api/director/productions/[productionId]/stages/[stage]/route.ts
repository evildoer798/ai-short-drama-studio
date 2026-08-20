import { DirectorStageStatus, Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { directorSkillMetadata } from '@/lib/director-generation'
import {
  directorStageSchema,
  generateDirectorStageSchema,
  parseDirectorStageOutput,
  updateDirectorStageSchema,
} from '@/lib/director-system'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireDirectorProductionAccess } from '@/lib/permissions'
import { enqueueDirectorStageVersion } from '@/lib/queue'
import { syncDirectorCharacterStateAssets } from '@/lib/director-state-assets'

export async function POST(request: NextRequest, context: { params: Promise<{ productionId: string; stage: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { productionId, stage: rawStage } = await context.params
    const stage = directorStageSchema.parse(rawStage)
    const production = await requireDirectorProductionAccess(productionId, user.id)
    if (production.currentStage !== stage) {
      throw new HttpError(409, 'DIRECTOR_STAGE_LOCKED', '请先确认当前阶段，再进入下一阶段')
    }
    const body = generateDirectorStageSchema.parse(await request.json().catch(() => ({})))
    const active = await prisma.directorStageVersion.findFirst({
      where: { productionId, stage, status: DirectorStageStatus.generating },
      orderBy: { version: 'desc' },
    })
    if (active) return NextResponse.json({ stageVersion: active, reused: true }, { status: 202 })
    const aggregate = await prisma.directorStageVersion.aggregate({
      where: { productionId, stage }, _max: { version: true },
    })
    const metadata = directorSkillMetadata(stage)
    const stageVersion = await prisma.directorStageVersion.create({
      data: {
        productionId,
        stage,
        version: (aggregate._max.version || 0) + 1,
        status: DirectorStageStatus.generating,
        inputSnapshot: production.sourceSnapshot as Prisma.InputJsonValue,
        feedback: body.feedback || null,
        skillName: metadata.name,
        skillVersion: metadata.version,
      },
    })
    try {
      await enqueueDirectorStageVersion(stageVersion.id)
    } catch (error) {
      await prisma.directorStageVersion.update({
        where: { id: stageVersion.id },
        data: { status: DirectorStageStatus.failed, error: `QUEUE_SUBMIT_FAILED: ${error instanceof Error ? error.message : String(error)}` },
      })
      throw error
    }
    return NextResponse.json({ stageVersion, reused: false }, { status: 202 })
  })
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ productionId: string; stage: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { productionId, stage: rawStage } = await context.params
    const stage = directorStageSchema.parse(rawStage)
    await requireDirectorProductionAccess(productionId, user.id)
    const body = updateDirectorStageSchema.parse(await request.json())
    const output = parseDirectorStageOutput(stage, body.output)
    const latest = await prisma.directorStageVersion.findFirst({
      where: { productionId, stage }, orderBy: { version: 'desc' },
    })
    if (!latest || (
      latest.status !== DirectorStageStatus.ready
      && latest.status !== DirectorStageStatus.draft
      && latest.status !== DirectorStageStatus.failed
    )) {
      throw new HttpError(409, 'DIRECTOR_STAGE_NOT_EDITABLE', '当前阶段结果尚不可修改')
    }
    const updated = await prisma.directorStageVersion.update({
      where: { id: latest.id },
      data: { output: output as Prisma.InputJsonValue, status: DirectorStageStatus.ready, error: null },
    })
    if (stage === 'lira') await syncDirectorCharacterStateAssets(productionId, output)
    return NextResponse.json({ stageVersion: updated })
  })
}
