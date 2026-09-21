/**
 * Current Admin RBAC verification entrypoint.
 *
 * The executable permission inventory lives beside the server routes so it can
 * inspect the actual Hono route exports and their requireRole declarations.
 * This wrapper deliberately runs that inventory instead of duplicating a JWT
 * or route simulation that could drift from the cookie Session + Membership
 * contract.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const testFiles = [
  "test/v1-admin-authorization.test.ts",
  "test/v1-membership-invitation.test.ts",
];

console.log("=== LicenKit Instance Membership RBAC Verification ===");
console.log("Checking mounted /admin/instance, /admin/members, /admin/profile,");
console.log("/admin/invitations and existing business routes against current declarations.\n");

const result = spawnSync(
  pnpmCommand,
  ["--filter", "@licenkit/server", "exec", "vitest", "run", ...testFiles],
  {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error("RBAC verification process could not start:", result.error);
  process.exit(1);
}
if (result.signal) {
  console.error(`RBAC verification process terminated by signal ${result.signal}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`RBAC verification failed with exit status ${String(result.status)}`);
  process.exit(result.status ?? 1);
}

console.log("\nALL CURRENT INSTANCE MEMBERSHIP RBAC CHECKS PASSED.");
