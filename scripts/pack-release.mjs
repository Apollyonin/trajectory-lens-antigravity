import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugin.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const agyMarket = JSON.parse(fs.readFileSync(path.join(repoRoot, "agy-market.json"), "utf8"));

const uiHtml = path.join(repoRoot, "ui", "dist", "app.html");
if (!fs.existsSync(uiHtml)) {
  const uiRes = spawnSync(process.execPath, [path.join(repoRoot, "ui", "build.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (uiRes.status !== 0 || !fs.existsSync(uiHtml)) {
    throw new Error("Failed to build ui/dist/app.html");
  }
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

const wrapperName = `${manifest.name}-${manifest.version}`;
const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), "tl-release-"));
const stageDir = path.join(stageParent, wrapperName);

try {
  fs.mkdirSync(stageDir, { recursive: true });

  for (const file of [
    "plugin.json",
    "mcp_config.json",
    "hooks.json",
    "README.md",
    "README.en.md",
    "LICENSE",
    "agy-market.json",
  ]) {
    const src = path.join(repoRoot, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(stageDir, file));
    }
  }

  for (const dir of ["assets", "rules", "skills", "hooks", path.join("ui", "dist")]) {
    const src = path.join(repoRoot, dir);
    if (fs.existsSync(src)) {
      copyDirRecursive(src, path.join(stageDir, dir));
    }
  }

  // Copy sibling server modules (pure Node built-ins + relative imports)
  const serverSrcDir = path.join(repoRoot, "server");
  const serverStageDir = path.join(stageDir, "server");
  fs.mkdirSync(serverStageDir, { recursive: true });
  for (const entry of fs.readdirSync(serverSrcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mjs") && entry.name !== "mcp-server.mjs") {
      fs.copyFileSync(path.join(serverSrcDir, entry.name), path.join(serverStageDir, entry.name));
    }
  }

  // Bundle mcp-server.mjs with npm deps (@modelcontextprotocol/sdk, zod) while keeping sibling ./server/*.mjs external
  await esbuild.build({
    entryPoints: [path.join(serverSrcDir, "mcp-server.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: path.join(serverStageDir, "mcp-server.mjs"),
    banner: {
      js: [
        'import { createRequire as __agymCreateRequire } from "node:module";',
        "const require = __agymCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    plugins: [
      {
        name: "externalize-local-server-modules",
        setup(build) {
          build.onResolve({ filter: /^\.\// }, (args) => {
            if (path.resolve(args.resolveDir) === path.resolve(serverSrcDir)) {
              return { path: args.path, external: true };
            }
            return null;
          });
        },
      },
    ],
  });

  // Write minimal ESM package.json without external dependencies
  fs.writeFileSync(
    path.join(stageDir, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version: manifest.version,
        private: true,
        type: "module",
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const releaseDir = path.join(repoRoot, "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  const assetName = agyMarket.releaseAsset || `${manifest.name}.tar.gz`;
  const outTar = path.join(releaseDir, assetName);
  if (fs.existsSync(outTar)) fs.unlinkSync(outTar);

  const tarRes = spawnSync("tar", ["-czf", outTar, "-C", stageParent, wrapperName], {
    stdio: "inherit",
  });
  if (tarRes.status !== 0) {
    throw new Error(`tar exited with code ${tarRes.status}`);
  }

  const bytes = fs.statSync(outTar).size;
  console.log(`Built self-contained release archive: ${outTar} (${(bytes / 1024).toFixed(1)} KiB)`);
} finally {
  fs.rmSync(stageParent, { recursive: true, force: true });
}
