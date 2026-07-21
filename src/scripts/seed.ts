import { hash } from 'bcryptjs'
import { prisma } from '@/lib/db'

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase().trim()
  const password = process.env.SEED_ADMIN_PASSWORD || 'changeme123'
  const workspaceName = process.env.SEED_WORKSPACE_NAME || 'Short Drama Studio'
  const projectName = process.env.SEED_PROJECT_NAME || 'Demo Project'
  const existingUser = await prisma.user.findUnique({ where: { email } })
  const user = existingUser || await prisma.user.create({
    data: {
      email,
      name: 'Admin',
      passwordHash: await hash(password, 12),
    },
  })

  let workspace = await prisma.workspace.findFirst({
    where: {
      name: workspaceName,
      members: {
        some: { userId: user.id },
      },
    },
  })

  workspace ??= await prisma.workspace.create({
    data: {
      name: workspaceName,
      members: {
        create: {
          userId: user.id,
          role: 'owner',
        },
      },
    },
  })

  await prisma.workspaceMember.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: user.id,
      },
    },
    update: { role: 'owner' },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'owner',
    },
  })

  let project = await prisma.project.findFirst({
    where: {
      workspaceId: workspace.id,
      name: projectName,
    },
  })

  project ??= await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: projectName,
    },
  })

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: {
        projectId: project.id,
        userId: user.id,
      },
    },
    update: { role: 'owner' },
    create: {
      projectId: project.id,
      userId: user.id,
      role: 'owner',
    },
  })

  console.log(`Seeded admin account ${email}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
