import { PrismaClient } from '@prisma/client'
import { hash } from 'bcryptjs'

const prisma = new PrismaClient()
const email = process.env.LOCAL_ACCOUNT_EMAIL?.trim().toLowerCase()
const password = process.env.LOCAL_ACCOUNT_PASSWORD || ''
if (!email || password.length < 8) throw new Error('本地账号参数不完整')

const workspace = await prisma.workspace.findFirst({
  orderBy: { createdAt: 'asc' },
  include: { projects: { select: { id: true } } },
})
if (!workspace) throw new Error('本地数据库中没有可加入的工作区')

const passwordHash = await hash(password, 12)
const displayName = email.split('@')[0]
const user = await prisma.user.upsert({
  where: { email },
  update: { passwordHash, mustChangePassword: false },
  create: {
    email,
    name: displayName,
    passwordHash,
    mustChangePassword: false,
  },
})

await prisma.workspaceMember.upsert({
  where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  update: { role: 'member' },
  create: { workspaceId: workspace.id, userId: user.id, role: 'member' },
})
for (const project of workspace.projects) {
  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
    update: { role: 'member' },
    create: { projectId: project.id, userId: user.id, role: 'member' },
  })
}

console.log(JSON.stringify({ ok: true, email, projectCount: workspace.projects.length }))
await prisma.$disconnect()
