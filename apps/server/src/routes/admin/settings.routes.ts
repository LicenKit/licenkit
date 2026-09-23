import { Hono } from "hono";
import type { AppContext } from "../../types";
import { requireRole } from "../../middleware/auth";
import { NotFoundError } from "../../middleware/error";

const ALL_INSTANCE_ROLES = ["owner", "admin", "member", "viewer"] as const;

export const adminInstanceRouter = new Hono<AppContext>();

adminInstanceRouter.get(
  "/",
  requireRole([...ALL_INSTANCE_ROLES]),
  async (c) => {
    const instanceId = c.get("instanceId")!;
    const result = await c.env.DB
      .prepare(
        `SELECT id, name, slug, site_url AS customer_site_url, admin_api_url,
                status, created_at, updated_at
         FROM instances
         WHERE id = ?1
         LIMIT 1`,
      )
      .bind(instanceId)
      .all<{
        id: string;
        name: string;
        slug: string;
        customer_site_url: string;
        admin_api_url: string;
        status: "active" | "suspended" | "archived";
        created_at: string;
        updated_at: string;
      }>();
    const instance = result.results[0];
    if (!instance) throw new NotFoundError("Instance not found");
    return c.json({ success: true, data: instance });
  },
);
