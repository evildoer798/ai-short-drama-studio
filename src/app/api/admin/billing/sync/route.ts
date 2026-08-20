import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getCangyuanPricingCatalog, reconcilePendingUsage } from '@/lib/billing'
import { routeHandler } from '@/lib/http'

export async function POST() {
  return routeHandler(async () => {
    await requireAdmin()
    const pricing = await getCangyuanPricingCatalog({ forceRefresh: true })
    const reconciliation = await reconcilePendingUsage()
    return NextResponse.json({
      pricing: {
        version: pricing.payload.pricing_version,
        fetchedAt: pricing.fetchedAt.toISOString(),
        stale: pricing.stale,
      },
      reconciliation,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  })
}
