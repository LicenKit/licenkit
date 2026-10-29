import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite, watchSite } from "./build-site.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
buildSite();
if (!existsSync(`${repoRoot}/dist/admin/index.html`)) {
  const preparation = spawnSync("pnpm", ["--filter", "@licenkit/admin", "run", "build"], { cwd: repoRoot, env: process.env, stdio: "inherit" });
  if (preparation.error) throw preparation.error;
  if (preparation.status !== 0) process.exit(preparation.status ?? 1);
}
const commands = [
  ["pnpm", ["run", "dev:server"]],
  ["pnpm", ["--filter", "@licenkit/admin", "run", "dev"]],
];
const children = [];
let stopping = false;
const siteWatcher = watchSite({
  onBuild() { console.log("[LicenKit] Site assets updated."); },
  onError(error) {
    console.error(`[LicenKit] Site build failed: ${error.message}`);
    process.exitCode = 1;
    stop();
  },
});
children.push(...commands.map(([command, args]) => spawn(command, args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
})));

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  siteWatcher.close();
  for (const child of children) if (!child.killed) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
for (const child of children) {
  child.on("error", (error) => {
    console.error(`[LicenKit] Development process failed: ${error.message}`);
    stop();
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (stopping) return;
    stop();
    process.exitCode = code ?? 1;
  });
}
