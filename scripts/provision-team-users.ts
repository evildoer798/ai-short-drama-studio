import { randomBytes } from 'node:crypto'
import { hash } from 'bcryptjs'
import { prisma } from '@/lib/db'

const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{2,31}$/

function parseArguments() {
  const args = process.argv.slice(2)
  const projectFlagIndex = args.indexOf('--project-id')
  const projectId = projectFlagIndex >= 0 ? args[projectFlagIndex + 1] : undefined
  const usernames = args.filter((_, index) => (
    projectFlagIndex < 0
    || (index !== projectFlagIndex && index !== projectFlagIndex + 1)
  )).map((value) => value.trim().toLowerCase())

  if (!projectId || usernames.length === 0) {
    throw new Error('用法：npm run provision:users -- --project-id <项目ID> <用户名...>')
  }
  if (new Set(usernames).size !== usernames.length) {
    throw new Error('用户名不能重复')
  }
  for (const username of usernames) {
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(`用户名 ${username} 格式不正确`)
    }
  }

  return { projectId, usernames }
}

function generateInitialPassword() {
  return randomBytes(18).toString('base64url')
}

async function main() {
  const { projectId, usernames } = parseArguments()
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, workspaceId: true },
  })
  if (!project) throw new Error(`项目 ${projectId} 不存在`)

  const credentials = await Promise.all(usernames.map(async (username) => {
    const email = `${username}@imaideo.local`
    const initialPassword = generateInitialPassword()
    const passwordHash = await hash(initialPassword, 12)

    await prisma.$transaction(async (tx) => {
      const matches = await tx.user.findMany({
        where: { OR: [{ username }, { email }] },
      })
      if (matches.length > 1) {
        throw new Error(`用户名 ${username} 与现有账号发生冲突`)
      }

      const user = matches[0]
        ? await tx.user.update({
          where: { id: matches[0].id },
          data: {
            username,
            email,
            name: username,
            passwordHash,
            mustChangePassword: true,
          },
        })
        : await tx.user.create({
          data: {
            username,
            email,
            name: username,
            passwordHash,
            mustChangePassword: true,
          },
        })

      await tx.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: project.workspaceId,
            userId: user.id,
          },
        },
        update: { role: 'member' },
        create: {
          workspaceId: project.workspaceId,
          userId: user.id,
          role: 'member',
        },
      })
      await tx.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: project.id,
            userId: user.id,
          },
        },
        update: { role: 'member' },
        create: {
          projectId: project.id,
          userId: user.id,
          role: 'member',
        },
      })
    })

    return { username, initialPassword }
  }))

  console.log(JSON.stringify({ project: project.name, credentials }, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
