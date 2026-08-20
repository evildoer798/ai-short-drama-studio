import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireAssetAccess, requireWritableProject } from '@/lib/permissions'
import { characterPerformanceProfilesSchema } from '@/lib/acting-system'
import { serializeCharacterActingProfile, serializeVoiceProfile } from '@/lib/acting-data'

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { assetId } = await context.params
    const asset = await requireAssetAccess(assetId, user.id)
    if (asset.type !== 'character') {
      throw new HttpError(422, 'ACTING_PROFILE_CHARACTER_ONLY', '只有角色资产可以配置表演与声音档案')
    }
    const profiles = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { actingProfile: true, voiceProfile: true },
    })
    return NextResponse.json({
      actingProfile: serializeCharacterActingProfile(profiles?.actingProfile || null),
      voiceProfile: serializeVoiceProfile(profiles?.voiceProfile || null),
    })
  })
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { assetId } = await context.params
    const asset = await requireAssetAccess(assetId, user.id)
    await requireWritableProject(asset.projectId, user.id)
    if (asset.type !== 'character') {
      throw new HttpError(422, 'ACTING_PROFILE_CHARACTER_ONLY', '只有角色资产可以配置表演与声音档案')
    }
    const body = characterPerformanceProfilesSchema.parse(await request.json())
    const currentVoice = body.voiceProfile
      ? await prisma.voiceProfile.findUnique({ where: { assetId } })
      : null
    if (currentVoice?.locked && body.voiceProfile && !body.unlockVoice) {
      const changed = [
        'prompt',
        'ageDescriptor',
        'originAccent',
        'timbreRegister',
        'paceDelivery',
        'pressureShift',
      ].some((key) => (
        (currentVoice[key as keyof typeof currentVoice] || null)
        !== (body.voiceProfile?.[key as keyof typeof body.voiceProfile] || null)
      ))
      if (changed) {
        throw new HttpError(409, 'VOICE_PROFILE_LOCKED', '声音档案已锁定；请明确解锁后再修改声音身份')
      }
    }

    await prisma.$transaction(async (tx) => {
      if (body.actingProfile) {
        await tx.characterActingProfile.upsert({
          where: { assetId },
          create: { assetId, ...body.actingProfile },
          update: { ...body.actingProfile, version: { increment: 1 } },
        })
      }
      if (body.voiceProfile) {
        await tx.voiceProfile.upsert({
          where: { assetId },
          create: { assetId, ...body.voiceProfile },
          update: { ...body.voiceProfile, version: { increment: 1 } },
        })
      }
      const profiles = await tx.asset.findUnique({
        where: { id: assetId },
        select: { actingProfile: { select: { id: true } }, voiceProfile: { select: { id: true } } },
      })
      await tx.shotPerformance.updateMany({
        where: { assetId },
        data: {
          actingProfileId: profiles?.actingProfile?.id || null,
          voiceProfileId: profiles?.voiceProfile?.id || null,
        },
      })
    })

    const profiles = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { actingProfile: true, voiceProfile: true },
    })
    return NextResponse.json({
      actingProfile: serializeCharacterActingProfile(profiles?.actingProfile || null),
      voiceProfile: serializeVoiceProfile(profiles?.voiceProfile || null),
    })
  })
}
