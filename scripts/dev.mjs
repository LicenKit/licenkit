import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commands = [
  ["pnpm", ["--filter", "@licenkit/server", "run", "dev"]],
  ["pnpm", ["--filter", "@licenkit/admin", "run", "dev"]],
  [process.execPath, ["scripts/run-site.mjs", "dev"]],
];
const children = commands.map(([command, args]) => spawn(command, args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
}));
let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
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
