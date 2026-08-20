import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getAccountBillingData, getAdminBillingData, parseBillingFilters } from '@/lib/billing-data'
import { getCangyuanPricingCatalog } from '@/lib/billing'
import { routeHandler } from '@/lib/http'

export async function GET(request: NextRequest) {
  return routeHandler(async () => {
    await requireAdmin()
    const filters = parseBillingFilters(Object.fromEntries(request.nextUrl.searchParams.entries()))
    const [billing, account, pricing] = await Promise.all([
      getAdminBillingData(filters),
      filters.userId ? getAccountBillingData(filters.userId, filters) : null,
      getCangyuanPricingCatalog().catch(() => null),
    ])
    return NextResponse.json({
      billing,
      account,
      pricing: pricing ? {
        version: pricing.payload.pricing_version,
        fetchedAt: pricing.fetchedAt.toISOString(),
        stale: pricing.stale,
      } : null,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  })
}
