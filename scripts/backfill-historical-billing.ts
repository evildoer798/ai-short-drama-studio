import { backfillHistoricalMediaUsage } from '@/lib/billing-backfill'
import { prisma } from '@/lib/db'

const apply = process.argv.includes('--apply')

try {
  const result = await backfillHistoricalMediaUsage({ dryRun: !apply })
  console.log(JSON.stringify(result, null, 2))
  if (!apply && result.missing > 0) {
    console.log('Dry run only. Re-run with --apply to write the missing historical entries.')
  }
  if (result.unresolved > 0) process.exitCode = 2
} finally {
  await prisma.$disconnect()
}
