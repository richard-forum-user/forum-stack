#!/usr/bin/env node
/**
 * Build the Tauri updater manifest (`latest.json`) from the per-platform
 * bundle outputs produced by `tauri build`.
 *
 * Each Tauri build emits `*.sig` (base64 minisign) next to the
 * installer / updater artifact. We collect those and stitch them into
 * the JSON format the updater plugin expects:
 *
 *   https://v2.tauri.app/plugin/updater/
 *
 * Usage:
 *   node scripts/build-latest-json.mjs \
 *     --artifacts ./artifacts \
 *     --version 0.1.0 \
 *     --repo richard-forum-user/forum-stack \
 *     --out latest.json
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    out[args[i].replace(/^--/, "")] = args[i + 1];
  }
  return out;
}

// Map filename hints → Tauri updater platform key.
function platformFor(filename) {
  const f = filename.toLowerCase();
  if (f.endsWith(".dmg") || f.endsWith(".app.tar.gz")) {
    if (f.includes("aarch64") || f.includes("arm64")) return "darwin-aarch64";
    return "darwin-x86_64";
  }
  if (f.endsWith(".appimage") || f.endsWith(".appimage.tar.gz")) {
    if (f.includes("aarch64") || f.includes("arm64")) return "linux-aarch64";
    return "linux-x86_64";
  }
  if (f.endsWith(".msi") || f.endsWith("-setup.exe")) {
    if (f.includes("aarch64") || f.includes("arm64")) return "windows-aarch64";
    return "windows-x86_64";
  }
  return null;
}

// The updater downloads the file at `url`, then verifies it against
// `signature`. Prefer the `.app.tar.gz` / `.AppImage.tar.gz` /
// `.msi.zip` updater bundles when present, otherwise fall back to the
// installer artifact itself.
function preferUpdaterArtifact(files) {
  const ranked = (a, b) => {
    const score = (n) => {
      const x = n.toLowerCase();
      if (x.endsWith(".app.tar.gz")) return 5;
      if (x.endsWith(".appimage.tar.gz")) return 4;
      if (x.endsWith(".msi.zip")) return 3;
      if (x.endsWith(".nsis.zip")) return 2;
      if (x.endsWith(".dmg")) return 1;
      return 0;
    };
    return score(b) - score(a);
  };
  return [...files].sort(ranked)[0];
}

async function walk(dir) {
  const out = [];
  async function recurse(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await recurse(p);
      else out.push(p);
    }
  }
  await recurse(dir);
  return out;
}

async function main() {
  const args = parseArgs();
  const artifactsDir = args.artifacts || "./artifacts";
  const version = (args.version || "0.0.0").replace(/^v/, "");
  const repo = args.repo;
  const outPath = args.out || "latest.json";
  if (!repo) {
    throw new Error("--repo is required (e.g. richard-forum-user/forum-stack)");
  }
  if (!existsSync(artifactsDir)) {
    throw new Error(`artifacts dir not found: ${artifactsDir}`);
  }

  const all = await walk(artifactsDir);
  const sigs = all.filter((f) => f.endsWith(".sig"));
  const bundles = new Map();

  for (const sigPath of sigs) {
    const bundlePath = sigPath.replace(/\.sig$/, "");
    if (!all.includes(bundlePath)) continue;
    const platform = platformFor(path.basename(bundlePath));
    if (!platform) continue;
    if (!bundles.has(platform)) bundles.set(platform, []);
    bundles.get(platform).push({ bundlePath, sigPath });
  }

  const platforms = {};
  for (const [platform, candidates] of bundles) {
    const winner =
      candidates.length === 1
        ? candidates[0]
        : candidates.find(({ bundlePath }) =>
            preferUpdaterArtifact(candidates.map((c) => c.bundlePath)) === bundlePath
          ) || candidates[0];
    const signature = (await readFile(winner.sigPath, "utf8")).trim();
    const filename = path.basename(winner.bundlePath);
    const url = `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(
      filename
    )}`;
    platforms[platform] = { signature, url };
  }

  if (Object.keys(platforms).length === 0) {
    throw new Error(
      "no signed bundles found — did Tauri sign your build? " +
        "Check TAURI_SIGNING_PRIVATE_KEY is set in CI."
    );
  }

  const manifest = {
    version: `v${version}`,
    pub_date: new Date().toISOString(),
    notes: `Forum Pod ${version}`,
    platforms,
  };
  await writeFile(outPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${outPath}:`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
