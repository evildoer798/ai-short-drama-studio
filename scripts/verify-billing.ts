import { BillingTaskType } from '@prisma/client'
import { prisma } from '@/lib/db'
import { recordCompletedTextUsage, recordCompletedUsage } from '@/lib/billing'

async function main() {
  const user = await prisma.user.findFirst({
    where: { role: 'admin' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!user) throw new Error('BILLING_VERIFY_ADMIN_MISSING')
  const marker = `billing-verify-${Date.now()}`
  try {
    const mediaInput = {
      idempotencyKey: `${marker}:video`,
      userId: user.id,
      taskType: BillingTaskType.video,
      sourceType: 'billing_verify',
      sourceTaskId: marker,
      model: 'sd7-seedance-2.0-720p',
    }
    await recordCompletedUsage(mediaInput)
    await recordCompletedUsage(mediaInput)
    await recordCompletedTextUsage({
      idempotencyKey: `${marker}:text`,
      userId: user.id,
      sourceTaskId: marker,
      model: 'gpt-5.5',
      usage: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 },
    })
    const rows = await prisma.usageLedger.findMany({
      where: { sourceTaskId: marker },
      orderBy: { taskType: 'asc' },
    })
    if (rows.length !== 2) throw new Error(`BILLING_VERIFY_IDEMPOTENCY_FAILED: ${rows.length}`)
    const video = rows.find((row) => row.taskType === BillingTaskType.video)
    const text = rows.find((row) => row.taskType === BillingTaskType.text)
    if (video?.amount?.toString() !== '3.9') {
      throw new Error(`BILLING_VERIFY_VIDEO_PRICE_FAILED: ${video?.amount?.toString()}`)
    }
    if (!text?.amount || text.amount.lessThanOrEqualTo(0)) {
      throw new Error(`BILLING_VERIFY_TEXT_PRICE_FAILED: ${text?.amount?.toString()}`)
    }
    console.log(JSON.stringify({
      ok: true,
      rows: rows.length,
      videoAmount: video.amount?.toString(),
      textAmount: text.amount.toString(),
      pricingVersion: video.pricingVersion,
    }))
  } finally {
    await prisma.usageLedger.deleteMany({ where: { sourceTaskId: marker } })
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
