import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const customSite = join(repoRoot, "custom", "site");
const templateSite = join(repoRoot, "custom_template", "site");
const siteRoot = existsSync(join(customSite, "package.json")) ? customSite : templateSite;
const command = process.argv[2];

if (!command) {
  console.error("Usage: node scripts/run-site.mjs <script> [arguments...]");
  process.exit(2);
}

console.log(`[LicenKit] Site source: ${relative(repoRoot, siteRoot)}`);
const child = spawn("pnpm", ["--dir", siteRoot, "run", command, ...process.argv.slice(3)], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`[LicenKit] Failed to run Site command: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
