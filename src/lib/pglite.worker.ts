// Runs the demo database once for all open tabs (leader election), so a "server phone" tab and a
// "kitchen tablet" tab share the same data.
import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'

worker({
  async init() {
    return new PGlite('idb://golden-kbbq-demo', { relaxedDurability: true })
  },
})
