import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "termux-bot");
const destinationRoot =
  process.argv[2] != null
    ? path.resolve(process.argv[2])
    : path.join(
        repoRoot,
        "android-app",
        "app",
        "src",
        "main",
        "assets",
        "runtime",
      );
const destinationRuntimeDir = path.join(destinationRoot, "termux-bot");

if (!existsSync(sourceDir)) {
  throw new Error(`Source runtime directory not found: ${sourceDir}`);
}

if (!existsSync(path.join(sourceDir, "node_modules"))) {
  throw new Error(
    "termux-bot/node_modules is missing. Install dependencies before preparing Android runtime.",
  );
}

mkdirSync(destinationRoot, { recursive: true });
rmSync(destinationRuntimeDir, { recursive: true, force: true });

cpSync(sourceDir, destinationRuntimeDir, {
  recursive: true,
  force: true,
  filter(sourcePath) {
    const relativePath = path.relative(sourceDir, sourcePath);
    if (relativePath === "") return true;

    const topLevelName = relativePath.split(path.sep)[0];
    if (topLevelName === ".data") return false;
    if (topLevelName === ".pnpm-store") return false;
    if (topLevelName === "pnpm-lock.yaml") return false;
    if (topLevelName === "README.md") return false;

    // Android asset merging treats prismarine-nbt sample fixtures as duplicates.
    // They are not needed at runtime, so skip bundling that sample directory.
    const prismarineNbtSampleDir = path.join(
      "node_modules",
      "prismarine-nbt",
      "sample",
    );
    if (
      relativePath === prismarineNbtSampleDir ||
      relativePath.startsWith(`${prismarineNbtSampleDir}${path.sep}`)
    ) {
      return false;
    }

    return true;
  },
});

writeFileSync(
  path.join(destinationRoot, "manifest.properties"),
  `runtime.version=${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}
runtime.name=MinecraftBOT
runtime.port=38080
`,
  "utf8",
);

console.log(`Prepared Android runtime at ${destinationRuntimeDir}`);
