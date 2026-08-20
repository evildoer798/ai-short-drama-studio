import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getAccountBillingData, parseBillingFilters } from '@/lib/billing-data'
import { getCangyuanPricingCatalog } from '@/lib/billing'
import { BillingWorkspace } from '@/components/BillingWorkspace'

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')
  const filters = parseBillingFilters(await searchParams)
  const [accountData, pricing] = await Promise.all([
    getAccountBillingData(user.id, filters),
    getCangyuanPricingCatalog().catch(() => null),
  ])
  return <BillingWorkspace
    admin={false}
    canAdmin={user.role === 'admin'}
    filters={filters}
    accountData={accountData}
    pricing={pricing ? {
      version: pricing.payload.pricing_version,
      fetchedAt: pricing.fetchedAt,
      stale: pricing.stale,
    } : null}
  />
}
