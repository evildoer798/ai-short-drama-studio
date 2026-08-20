import { AccountRole } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getCurrentUser, requireAdmin } from '@/lib/auth'
import { getAccountBillingData, getAdminBillingData, parseBillingFilters } from '@/lib/billing-data'
import { getCangyuanPricingCatalog, reconcilePendingUsage } from '@/lib/billing'
import { backfillHistoricalMediaUsage } from '@/lib/billing-backfill'
import { BillingWorkspace } from '@/components/BillingWorkspace'

async function syncOfficialPricing() {
  'use server'
  await requireAdmin()
  await getCangyuanPricingCatalog({ forceRefresh: true })
  await backfillHistoricalMediaUsage({ dryRun: false })
  await reconcilePendingUsage()
  revalidatePath('/admin/billing')
  revalidatePath('/billing')
}

export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')
  if (user.role !== AccountRole.admin) redirect('/billing')
  const filters = parseBillingFilters(await searchParams)
  const [adminData, accountData, pricing] = await Promise.all([
    getAdminBillingData(filters),
    filters.userId ? getAccountBillingData(filters.userId, filters) : null,
    getCangyuanPricingCatalog().catch(() => null),
  ])
  return <BillingWorkspace
    admin
    filters={filters}
    accountData={accountData}
    adminData={adminData}
    pricing={pricing ? {
      version: pricing.payload.pricing_version,
      fetchedAt: pricing.fetchedAt,
      stale: pricing.stale,
    } : null}
    syncAction={syncOfficialPricing}
  />
}
