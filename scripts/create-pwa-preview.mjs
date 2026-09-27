// Make a private-env-free production test copy. Never builds in the working tree.
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = "goal-coach-pwa-preview-";
const previewParent = join(root, "dist");
const folders = ["drizzle", "e2e", "e2e-invite", "public", "scripts", "src"];
const files = ["package.json", "pnpm-lock.yaml", "next.config.ts", "next-env.d.ts", "tsconfig.json", "playwright.config.ts", "playwright.invite.config.ts", "vitest.config.ts", "vitest.setup.ts"];

function assertOwned(path) {
  const target = resolve(path);
  if (dirname(target) !== resolve(previewParent) || !basename(target).startsWith(prefix)) throw new Error("Unsafe preview path");
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".env") || entry.name === "node_modules" || entry.name === ".next" || entry.name === "test-results") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Refusing source link: ${from}`);
    if (stat.isDirectory()) await copyTree(from, to);
    else if (stat.isFile() && !/\.(?:db|sqlite)(?:-(?:wal|shm|journal))?$/.test(entry.name)) await copyFile(from, to);
  }
}

await mkdir(previewParent, { recursive: true });
const destination = await mkdtemp(join(previewParent, prefix));
assertOwned(destination);
try {
  for (const folder of folders) await copyTree(join(root, folder), join(destination, folder));
  for (const file of files) await copyFile(join(root, file), join(destination, file));
  console.log(destination);
} catch (error) {
  assertOwned(destination);
  await rm(destination, { recursive: true, force: true });
  throw error;
}
