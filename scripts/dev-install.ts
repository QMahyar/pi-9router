/**
 * Dev install: copy the extension tree into pi's installed package location
 * so /reload picks up local changes without publishing.
 *
 * Targets:
 *   (default)  ~/.pi/agent/npm/node_modules/@qmahyar/pi-9router/extensions
 *              — where `pi install npm:@qmahyar/pi-9router` lands on this
 *              machine (settings.json packages). `pi update` restores it.
 *   --loose    ~/.pi/agent/extensions/  (legacy auto-discover path; entries
 *              + lib/ — only if you deliberately use the loose-file setup)
 *
 * Copies extensions/*.ts and extensions/lib/*.ts (ALL of them, so new lib
 * files never get forgotten). Run from the repo root:
 *
 *   bun run dev-install
 *
 * Then /reload inside pi (no process restart needed).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const repo = process.cwd();
const srcRoot = join(repo, "extensions");
const loose = process.argv.includes("--loose");

if (!statSync(srcRoot, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(
    `No extensions/ directory found in ${repo} — run from the repo root.`,
  );
  process.exit(1);
}

// Verify the entry files actually bundle before installing a broken tree.
const outdir = join(homedir(), ".pi", "agent", "npm", ".nrbuild-tmp");
const build = Bun.spawnSync(
  [
    "bun",
    "build",
    "extensions/9router.ts",
    "extensions/9router-tools.ts",
    "--target=node",
    "--external",
    "*",
    "--outdir",
    outdir,
  ],
  { cwd: repo, stdout: "pipe", stderr: "pipe" },
);
if (build.exitCode !== 0) {
  console.error(
    "bun build failed — fix errors before installing:\n" +
      build.stderr.toString(),
  );
  process.exit(1);
}
try {
  cpSync(outdir, outdir, { recursive: true }); // no-op keep-alive
} catch {
  /* ignore */
}
for (const f of readdirSync(outdir)) {
  try {
    require("node:fs").unlinkSync(join(outdir, f));
  } catch {
    /* ignore */
  }
}
try {
  require("node:fs").rmdirSync(outdir);
} catch {
  /* ignore */
}

const destRoot = loose
  ? join(homedir(), ".pi", "agent", "extensions")
  : join(
      homedir(),
      ".pi",
      "agent",
      "npm",
      "node_modules",
      "@qmahyar",
      "pi-9router",
      "extensions",
    );

if (!loose && !existsSync(join(destRoot, "..", "package.json"))) {
  console.error(
    `Package path ${destRoot} not found — is @qmahyar/pi-9router installed via 'pi install'?\n` +
      "Use --loose to target the legacy auto-discover path instead.",
  );
  process.exit(1);
}

mkdirSync(destRoot, { recursive: true });
mkdirSync(join(destRoot, "lib"), { recursive: true });

let copied = 0;
for (const name of readdirSync(srcRoot)) {
  if (name.endsWith(".ts")) {
    cpSync(join(srcRoot, name), join(destRoot, name));
    copied++;
  }
}
const libDir = join(srcRoot, "lib");
if (statSync(libDir, { throwIfNoEntry: false })?.isDirectory()) {
  for (const name of readdirSync(libDir)) {
    if (name.endsWith(".ts")) {
      cpSync(join(libDir, name), join(destRoot, "lib", name));
      copied++;
    }
  }
}

console.log(`Copied ${copied} files to ${destRoot}${loose ? " (loose)" : ""}`);
console.log("Now run /reload inside pi (or restart it).");
