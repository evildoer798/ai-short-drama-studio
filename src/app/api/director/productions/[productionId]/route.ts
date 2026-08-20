import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { getDirectorProductionData } from '@/lib/director-data'
import { prisma } from '@/lib/db'
import { routeHandler } from '@/lib/http'
import { requireDirectorProductionAccess } from '@/lib/permissions'

export async function GET(_request: Request, context: { params: Promise<{ productionId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { productionId } = await context.params
    await requireDirectorProductionAccess(productionId, user.id)
    return NextResponse.json({ production: await getDirectorProductionData(productionId) })
  })
}

export async function PATCH(request: Request, context: { params: Promise<{ productionId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { productionId } = await context.params
    await requireDirectorProductionAccess(productionId, user.id)
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(await request.json())
    const production = await prisma.directorProduction.update({
      where: { id: productionId }, data: { name: body.name }, select: { id: true, name: true },
    })
    return NextResponse.json({ production })
  })
}
