import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const customConfig = join(repoRoot, "custom", "wrangler.jsonc");
const templateConfig = join(repoRoot, "custom_template", "wrangler.jsonc");
const config = existsSync(customConfig) ? customConfig : templateConfig;
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/run-wrangler.mjs <wrangler arguments...>");
  process.exit(2);
}

console.log(`[LicenKit] Wrangler config: ${relative(repoRoot, config)}`);
const child = spawn("pnpm", ["--dir", join(repoRoot, "apps", "server"), "exec", "wrangler", ...args, "--config", config], {
  cwd: repoRoot,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? join(repoRoot, ".wrangler", "logs"),
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`[LicenKit] Failed to run Wrangler: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
