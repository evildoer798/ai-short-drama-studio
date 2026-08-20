import { describe, expect, it } from 'vitest'
import {
  historicalLegacyPrice,
  historicalVideoDuration,
} from '../../src/lib/billing-backfill'

describe('historical billing backfill', () => {
  it('prefers the task payload duration over the current storyboard duration', () => {
    expect(historicalVideoDuration({ duration: 8 }, 15)).toBe(8)
    expect(historicalVideoDuration({}, 15)).toBe(15)
  })

  it('keeps auditable legacy prices for models removed from the live catalog', () => {
    expect(historicalLegacyPrice('seedance-2.0-720p')).toMatchObject({
      billingMode: 'per_second',
      unitPrice: '0.975',
    })
    expect(historicalLegacyPrice('unknown-model')).toBeNull()
  })
})
