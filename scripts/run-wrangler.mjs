import { rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(repoRoot, "wrangler.jsonc");
const rawArgs = process.argv.slice(2);

function normalizeRootRelativePaths(args) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--outdir" && args[index + 1]) {
      normalized.push(argument, resolve(repoRoot, args[index + 1]));
      index += 1;
    } else if (argument.startsWith("--outdir=")) {
      normalized.push(`--outdir=${resolve(repoRoot, argument.slice("--outdir=".length))}`);
    } else {
      normalized.push(argument);
    }
  }
  return normalized;
}

function removeEmptyWranglerDirectories() {
  const wranglerDirectory = join(dirname(config), ".wrangler");
  for (const directory of [join(wranglerDirectory, "tmp"), wranglerDirectory]) {
    try { rmdirSync(directory); } catch { /* Keep non-empty Wrangler state. */ }
  }
}

const args = normalizeRootRelativePaths(rawArgs);

if (args.length === 0) {
  console.error("Usage: node scripts/run-wrangler.mjs <wrangler arguments...>");
  process.exit(2);
}

console.log("[LicenKit] Wrangler config: wrangler.jsonc");
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
  removeEmptyWranglerDirectories();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
