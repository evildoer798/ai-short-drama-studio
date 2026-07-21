import { PrismaClient } from '@prisma/client'
import { hash } from 'bcryptjs'

let input = ''
for await (const chunk of process.stdin) input += chunk

const payload = JSON.parse(input)
const email = String(payload.email || '').trim().toLowerCase()
const password = String(payload.password || '')

if (!email) throw new Error('EMAIL_REQUIRED')
if (password.length < 10 || password.length > 128) {
  throw new Error('PASSWORD_LENGTH_INVALID')
}

const prisma = new PrismaClient()

try {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) throw new Error('USER_NOT_FOUND')

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hash(password, 12),
      mustChangePassword: false,
    },
  })

  process.stdout.write(JSON.stringify({ ok: true, email }))
} finally {
  await prisma.$disconnect()
}
