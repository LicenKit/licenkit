import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { validateSiteConfig } from "../apps/site/builtin/assets/config.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const publicExtensions = new Set([".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".txt", ".xml", ".webmanifest", ".pdf"]);
const reservedPaths = new Set(["admin", "api", "__site"]);
const controlFiles = new Set(["_headers", "_redirects", "_worker.js", ".assetsignore"]);

function siteFiles(sourceDirectory, label) {
  const files = [];
  function visit(directory, segments = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const parts = [...segments, entry.name];
      const path = join(directory, entry.name);
      const displayPath = `${label}/${parts.join("/")}`;
      if (controlFiles.has(entry.name.toLowerCase())) throw new Error(`${displayPath}: deployment control files are not public Site resources.`);
      if (entry.name.startsWith(".")) continue;
      if (/[\\%?#]/u.test(entry.name)) throw new Error(`${displayPath}: the filename contains an ambiguous URL character.`);
      if (segments.length === 0 && reservedPaths.has(entry.name.toLowerCase().replace(/\.html$/u, ""))) throw new Error(`${displayPath}: this path is reserved by LicenKit.`);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`${displayPath}: symbolic links are not allowed in published Site resources.`);
      if (stat.isDirectory()) {
        visit(path, parts);
      } else if (stat.isFile()) {
        if (!publicExtensions.has(extname(entry.name).toLowerCase())) throw new Error(`${displayPath}: this file type is not a public Site resource.`);
        files.push({ source: path, path: parts.join("/") });
      } else {
        throw new Error(`${displayPath}: only regular files and directories can be published.`);
      }
    }
  }
  if (lstatSync(sourceDirectory).isSymbolicLink()) throw new Error(`${label}: the template directory must not be a symbolic link.`);
  visit(sourceDirectory);
  return files;
}

/** Publish both trees independently; the Worker selects a file at request time. */
export function buildSite({ projectRoot = repositoryRoot } = {}) {
  const sourceRoot = join(projectRoot, "apps", "site");
  const builtinRoot = join(sourceRoot, "builtin");
  const customRoot = join(sourceRoot, "custom");
  for (const path of [join(projectRoot, "apps"), sourceRoot, join(projectRoot, "dist")]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`${relative(projectRoot, path)}: source and output directories must not be symbolic links.`);
  }
  if (!existsSync(builtinRoot)) throw new Error("apps/site/builtin: the built-in templates are missing.");
  mkdirSync(customRoot, { recursive: true });
  const builtinFiles = siteFiles(builtinRoot, "builtin");
  const customFiles = siteFiles(customRoot, "custom");
  const selectedConfig = customFiles.find((file) => file.path === "site.json") ?? builtinFiles.find((file) => file.path === "site.json");
  if (!selectedConfig) throw new Error("site.json: neither custom nor builtin supplies the public Site configuration.");
  let config;
  if (lstatSync(selectedConfig.source).size > 128 * 1024) throw new Error(`${relative(projectRoot, selectedConfig.source)}: the public configuration must not exceed 128 KiB.`);
  try {
    config = JSON.parse(readFileSync(selectedConfig.source, "utf8"));
  } catch {
    throw new Error(`${relative(projectRoot, selectedConfig.source)}: invalid JSON.`);
  }
  try {
    validateSiteConfig(config);
  } catch (error) {
    throw new Error(`${relative(projectRoot, selectedConfig.source)}: ${error.message}`);
  }
  for (const file of [...builtinFiles, ...customFiles]) {
    if (extname(file.path).toLowerCase() !== ".js") continue;
    const result = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: readFileSync(file.source), encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (result.error) throw new Error(`${relative(projectRoot, file.source)}: JavaScript syntax check could not run (${result.error.code ?? result.error.name}).`);
    if (result.status !== 0) {
      const line = /\[stdin\]:(\d+)/u.exec(result.stderr)?.[1];
      const message = /SyntaxError: ([^\n]+)/u.exec(result.stderr)?.[1] ?? "the syntax checker rejected this module";
      throw new Error(`${relative(projectRoot, file.source)}${line ? `:${line}` : ""}: invalid JavaScript module syntax: ${message}`);
    }
  }

  // Validate all sources before replacing this build's Site output. Admin assets
  // and the user's source trees are never removed by the Site builder.
  const outputRoot = join(projectRoot, "dist", "__site");
  rmSync(outputRoot, { recursive: true, force: true });
  for (const [kind, files] of [["builtin", builtinFiles], ["custom", customFiles]]) {
    mkdirSync(join(outputRoot, kind), { recursive: true });
    for (const file of files) {
      const destination = join(outputRoot, kind, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(file.source, destination);
    }
  }
  return { builtinCount: builtinFiles.length, customCount: customFiles.length, configPath: relative(projectRoot, selectedConfig.source) };
}

function sourceState(projectRoot) {
  const state = [];
  for (const path of [join(projectRoot, "apps"), join(projectRoot, "apps", "site")]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`${relative(projectRoot, path)}: template directories must not be symbolic links.`);
  }
  function visit(directory, displayPath) {
    if (!existsSync(directory)) {
      state.push(`${displayPath}:missing`);
      return;
    }
    const stat = lstatSync(directory, { bigint: true });
    state.push(`${displayPath}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of readdirSync(directory).sort()) {
      if (entry.startsWith(".") && !controlFiles.has(entry.toLowerCase())) continue;
      visit(join(directory, entry), `${displayPath}/${entry}`);
    }
  }
  for (const kind of ["builtin", "custom"]) visit(join(projectRoot, "apps", "site", kind), kind);
  return state.join("\n");
}

/** Check source metadata for additions, edits and deletions; never poll file contents. */
export function watchSite({ projectRoot = repositoryRoot, onBuild = () => {}, onError = (error) => { throw error; }, debounceMs = 100, intervalMs = 200 } = {}) {
  let previous = sourceState(projectRoot);
  let timer;
  let interval;
  let closed = false;
  const close = () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(interval);
  };
  const failed = (error) => {
    close();
    onError(error);
  };
  interval = setInterval(() => {
    if (closed) return;
    try {
      const current = sourceState(projectRoot);
      if (current !== previous) {
        previous = current;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (closed) return;
          try {
            onBuild(buildSite({ projectRoot }));
          } catch (error) {
            failed(error);
          }
        }, debounceMs);
      }
    } catch (error) {
      failed(error);
    }
  }, intervalMs);
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--watch") || args.length > 1) throw new Error("Usage: node scripts/build-site.mjs [--watch]");
  const report = ({ builtinCount, customCount }) => console.log(`[LicenKit] Site built: ${builtinCount} builtin and ${customCount} custom files.`);
  report(buildSite());
  if (args.includes("--watch")) {
    const watcher = watchSite({
      onBuild: report,
      onError(error) {
        console.error(`[LicenKit] Site build failed: ${error.message}`);
        process.exitCode = 1;
      },
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => watcher.close());
  }
}
