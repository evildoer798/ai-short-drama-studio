import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { getProjectHubData } from '@/lib/project-hub-data'
import { createProjectSchema, projectRoleForWorkspaceMember } from '@/lib/projects'

export async function GET() {
  return routeHandler(async () => {
    const user = await requireUser()
    return NextResponse.json(await getProjectHubData(user.id))
  })
}

export async function POST(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const body = createProjectSchema.parse(await request.json())
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: body.workspaceId,
          userId: user.id,
        },
      },
    })
    if (!membership) {
      throw new HttpError(403, 'WORKSPACE_FORBIDDEN', '你没有在这个工作区中新建项目的权限')
    }

    const workspaceMembers = body.shareWithWorkspace
      ? await prisma.workspaceMember.findMany({
          where: { workspaceId: body.workspaceId },
          select: { userId: true, role: true },
        })
      : [{ userId: user.id, role: membership.role }]
    const project = await prisma.project.create({
      data: {
        workspaceId: body.workspaceId,
        name: body.name,
        visualStyle: body.visualStyle,
        members: {
          create: workspaceMembers.map((workspaceMember) => ({
            userId: workspaceMember.userId,
            role: projectRoleForWorkspaceMember({
              workspaceRole: workspaceMember.role,
              isCreator: workspaceMember.userId === user.id,
            }),
          })),
        },
      },
      select: { id: true, name: true },
    })

    return NextResponse.json({ project }, { status: 201 })
  })
}
