import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const ALLOWED_TOP_LEVEL_FILES = [
  "Dockerfile",
  ".dockerignore",
  "compose.yaml",
  ".env.example",
  ".gitignore",
  ".node-version",
  "README.md",
  "drizzle.config.ts",
  "eslint.config.mjs",
  "next-env.d.ts",
  "next.config.ts",
  "package.json",
  "playwright.config.ts",
  "playwright.invite.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.setup.ts",
];
const ALLOWED_TOP_LEVEL_DIRECTORIES = [
  "deploy",
  "docs",
  "drizzle",
  "e2e",
  "e2e-invite",
  "evals",
  "public",
  "scripts",
  "src",
];
const REQUIRED_PWA_FILES = [
  "public/sw.js",
  "public/offline.html",
  "public/icons/icon-192.png",
  "public/icons/icon-512.png",
  "public/icons/apple-touch-icon-180.png",
  "src/app/manifest.ts",
];
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".next",
  ".superpowers",
  ".worktrees",
  "coverage",
  "dist",
  "exports",
  "node_modules",
  "playwright-report",
  "test-results",
]);

async function pathExists(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function toManifestPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isForbidden(relativePath) {
  const manifestPath = toManifestPath(relativePath);
  const normalized = manifestPath.toLowerCase();
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return true;
  if (normalized === "data" || normalized.startsWith("data/")) return true;
  if (normalized === "docs/superpowers" || normalized.startsWith("docs/superpowers/")) return true;
  if (normalized === "evals/results" || normalized.startsWith("evals/results/")) return true;
  if ((name.startsWith(".env") || name.endsWith(".env") || name.includes(".env."))
    && manifestPath !== ".env.example" && manifestPath !== "deploy/.env.example") return true;
  if (name.endsWith(".log") || name.endsWith(".tsbuildinfo")) return true;
  if (/\.(?:db|db3|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/.test(name)) return true;
  return false;
}

async function collectDirectory(projectRoot, absoluteDirectory, collected) {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolute = path.join(absoluteDirectory, entry.name);
    const relative = path.relative(projectRoot, absolute);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`源码白名单内不允许符号链接：${toManifestPath(relative)}`);
    }
    if (isForbidden(relative)) continue;
    if (stat.isDirectory()) {
      await collectDirectory(projectRoot, absolute, collected);
    } else if (stat.isFile()) {
      collected.push({ absolute, relative: toManifestPath(relative) });
    }
  }
}

async function collectAllowedFiles(projectRoot) {
  const collected = [];
  for (const relative of ALLOWED_TOP_LEVEL_FILES) {
    const absolute = path.join(projectRoot, relative);
    const stat = await pathExists(absolute);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`源码白名单内不允许符号链接：${relative}`);
    if (!stat.isFile()) throw new Error(`白名单文件不是普通文件：${relative}`);
    if (!isForbidden(relative)) collected.push({ absolute, relative: toManifestPath(relative) });
  }
  for (const relative of ALLOWED_TOP_LEVEL_DIRECTORIES) {
    const absolute = path.join(projectRoot, relative);
    const stat = await pathExists(absolute);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`源码白名单内不允许符号链接：${relative}`);
    if (!stat.isDirectory()) throw new Error(`白名单目录不是目录：${relative}`);
    await collectDirectory(projectRoot, absolute, collected);
  }
  collected.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  return collected;
}

function safeArtifactName(name, version) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const safeVersion = version.replace(/[^0-9a-z._-]+/gi, "-").replace(/^-+|-+$/g, "");
  if (!safeName || !safeVersion) throw new Error("package.json 缺少可用于源码包名称的 name 或 version");
  return `${safeName}-source-v${safeVersion}`;
}

function validateDestination(distRoot, outputDirectory) {
  const relative = path.relative(distRoot, outputDirectory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("源码包目标必须是项目 dist 下的新版本目录");
  }
}

export async function packageSource(projectRoot = PROJECT_ROOT) {
  const root = path.resolve(projectRoot);
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const artifactName = safeArtifactName(String(packageJson.name ?? ""), String(packageJson.version ?? ""));
  const distRoot = path.join(root, "dist");
  const outputDirectory = path.join(distRoot, artifactName);
  validateDestination(distRoot, outputDirectory);

  const distStat = await pathExists(distRoot);
  if (distStat?.isSymbolicLink()) throw new Error("dist 不能是符号链接");
  if (distStat && !distStat.isDirectory()) throw new Error("dist 已存在但不是目录");
  if (await pathExists(outputDirectory)) {
    throw new Error(`源码包目标已存在，拒绝覆盖：${outputDirectory}`);
  }

  const files = await collectAllowedFiles(root);
  const included = new Set(files.map(file => file.relative));
  for (const required of REQUIRED_PWA_FILES) {
    if (!included.has(required)) throw new Error(`PWA 源码包缺少必要文件：${required}`);
  }
  let createdOutput = false;
  try {
    await mkdir(distRoot, { recursive: true });
    const readyDistStat = await lstat(distRoot);
    if (readyDistStat.isSymbolicLink()) throw new Error("dist 不能是符号链接");
    if (!readyDistStat.isDirectory()) throw new Error("dist 已存在但不是目录");
    try {
      await mkdir(outputDirectory);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(`源码包目标已存在，拒绝覆盖：${outputDirectory}`);
      }
      throw error;
    }
    createdOutput = true;
    const manifestFiles = [];
    for (const file of files) {
      const sourceStat = await lstat(file.absolute);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new Error(`复制前源文件类型发生变化：${file.relative}`);
      }
      const destination = path.join(outputDirectory, ...file.relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file.absolute, destination);
      const bytes = await readFile(destination);
      manifestFiles.push({
        path: file.relative,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const manifest = {
      schemaVersion: 1,
      algorithm: "sha256",
      package: { name: packageJson.name, version: packageJson.version },
      files: manifestFiles,
    };
    await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { outputDirectory, manifest };
  } catch (error) {
    if (createdOutput) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const result = await packageSource();
  console.log(`源码交付目录：${result.outputDirectory}`);
  console.log(`SHA-256 清单：${path.join(result.outputDirectory, "manifest.json")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`源码打包失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
