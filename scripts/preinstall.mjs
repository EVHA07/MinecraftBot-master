import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error("Use pnpm instead.");
  process.exit(1);
}

for (const lockfile of ["package-lock.json", "yarn.lock"]) {
  const filePath = path.join(rootDir, lockfile);
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}
