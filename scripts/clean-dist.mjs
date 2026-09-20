import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const deploymentDirectory = join(repoRoot, "dist");

rmSync(deploymentDirectory, { recursive: true, force: true });
