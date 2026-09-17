import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import type { AppContext } from "../../types";
import * as schema from "./schema";

export type LicenKitDB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Returns the tenant database instance.
 * In self-hosted LicenKit, all tenants reside in the primary c.env.DB.
 * In LicenKit-Cloud, this function dynamically routes to the appropriate D1 shard based on accountId.
 */
export function getTenantDB(c: Context<AppContext>, accountId?: string): LicenKitDB {
  return drizzle(c.env.DB, { schema });
}

export { schema };
