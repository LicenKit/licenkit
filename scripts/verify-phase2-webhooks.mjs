/**
 * Paddle webhook, fulfillment and email readiness verification.
 * Runs the current implementation tests instead of maintaining a second protocol.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const groups = [
  {
    "packageName": "@licenkit/server",
    "testFiles": [
      "test/v1-billing-checkout.test.ts",
      "test/billing-email-readiness.test.ts"
    ]
  }
];

for (const { packageName, testFiles } of groups) {
  const result = spawnSync(
    pnpmCommand,
    ["--filter", packageName, "exec", "vitest", "run", ...testFiles],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error) {
    console.error("Verification process could not start:", result.error);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`Verification process terminated by signal ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Verification failed with exit status ${String(result.status)}`);
    process.exit(result.status ?? 1);
  }
}

console.log("Paddle webhook, fulfillment and email readiness verification passed.");
