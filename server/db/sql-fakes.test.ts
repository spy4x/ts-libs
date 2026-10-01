// The two fake `Sql` clients, held to the same contract the integration tier runs on a real client
// (`sql-contract.integration.test.ts`). The migration driver tests run on one fake and the service
// tests on the other.

import { createFakeSql as createMigrateFake } from "./testing/fake-sql-migrate.ts"
import { createFakeSql as createServicesFake } from "./testing/fake-sql-services.ts"
import { describeSqlHandleContract, describeSqlLockContract } from "./sql-contract.test.ts"

describeSqlHandleContract("the migration fake", () => {
  return Promise.resolve({ sql: createMigrateFake().sql, close: () => Promise.resolve() })
}, { full: false })

describeSqlHandleContract("the services fake", () => {
  return Promise.resolve({ sql: createServicesFake().sql, close: () => Promise.resolve() })
}, { full: true })

describeSqlLockContract("the migration fake", () => {
  const fake = createMigrateFake()
  return Promise.resolve({
    sql: fake.sql,
    close: () => Promise.resolve(),
    holdLockElsewhere: () => {
      fake.setLockHeldElsewhere(true)
      return Promise.resolve()
    },
    releaseLockElsewhere: () => {
      fake.setLockHeldElsewhere(false)
      return Promise.resolve()
    },
  })
})
