import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { getAccountBillingData, parseBillingFilters } from '@/lib/billing-data'
import { getCangyuanPricingCatalog } from '@/lib/billing'
import { routeHandler } from '@/lib/http'

export async function GET(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const filters = parseBillingFilters(Object.fromEntries(request.nextUrl.searchParams.entries()))
    const [billing, pricing] = await Promise.all([
      getAccountBillingData(user.id, filters),
      getCangyuanPricingCatalog().catch(() => null),
    ])
    return NextResponse.json({
      billing,
      pricing: pricing ? {
        version: pricing.payload.pricing_version,
        fetchedAt: pricing.fetchedAt.toISOString(),
        stale: pricing.stale,
      } : null,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  })
}
