import { describe, expect, it } from 'vitest'
import { makeDb } from './harness'
describe('migrations', () => {
  it('load with the seed', async () => {
    const { one } = await makeDb()
    expect(Number((await one<{ n: number }>('select count(*)::int n from items')).n)).toBeGreaterThan(30)
  })
})
