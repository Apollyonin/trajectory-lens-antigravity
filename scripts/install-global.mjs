import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..");
const DEST_ROOT = path.join(os.homedir(), ".gemini", "config", "plugins", "trajectory-lens");

const RUNTIME_FILES = [
  "plugin.json",
  "mcp_config.json",
  "hooks.json",
  "package.json",
  "README.md",
];

const SYNC_DIRS = [
  "assets",
  "rules",
  "skills",
  "hooks",
  "server",
  path.join("ui", "dist"),
];

function syncDirClean(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const srcEntries = fs.readdirSync(src, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  // Remove stale files/dirs that no longer exist in source
  for (const existing of fs.readdirSync(dst, { withFileTypes: true })) {
    if (!srcNames.has(existing.name)) {
      try {
        fs.rmSync(path.join(dst, existing.name), { recursive: true, force: true });
      } catch {}
    }
  }

  for (const entry of srcEntries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      syncDirClean(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

async function refreshAntigravityMcp() {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS?.trim();
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!addr || !csrf) {
    console.log("ANTIGRAVITY_LS_ADDRESS/ANTIGRAVITY_CSRF_TOKEN not set; skipping live MCP refresh.");
    return;
  }
  const url = `http://${addr}/exa.language_server_pb.LanguageServerService/RefreshMcpServers`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": csrf,
      },
      body: JSON.stringify({ serverName: "trajectory-lens_trajectory-lens" }),
    });
    const text = await res.text();
    console.log(`RefreshMcpServers (${res.status}): ${text || "ok"}`);
  } catch (err) {
    console.warn(`RefreshMcpServers warning: ${err.message}`);
  }
}

const uiDistHtml = path.join(SRC_ROOT, "ui", "dist", "app.html");
if (!fs.existsSync(uiDistHtml)) {
  throw new Error("ui/dist/app.html not found. Run `npm run build:ui` first.");
}

// Never delete DEST_ROOT itself on Windows because a live mcp-server.mjs process may hold it as cwd.
fs.mkdirSync(DEST_ROOT, { recursive: true });

for (const file of RUNTIME_FILES) {
  const src = path.join(SRC_ROOT, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DEST_ROOT, file));
  }
}

for (const dir of SYNC_DIRS) {
  const src = path.join(SRC_ROOT, dir);
  const dst = path.join(DEST_ROOT, dir);
  if (fs.existsSync(src)) {
    syncDirClean(src, dst);
  }
}

// Sync node_modules only when missing or package-lock.json changed (avoids locking native binaries unnecessarily)
const srcLock = path.join(SRC_ROOT, "package-lock.json");
const dstLock = path.join(DEST_ROOT, "package-lock.json");
const dstModules = path.join(DEST_ROOT, "node_modules");
let lockChanged = !fs.existsSync(dstModules);
if (!lockChanged && fs.existsSync(srcLock)) {
  if (!fs.existsSync(dstLock)) {
    lockChanged = true;
  } else {
    const a = fs.readFileSync(srcLock, "utf8");
    const b = fs.readFileSync(dstLock, "utf8");
    lockChanged = a !== b;
  }
}

if (lockChanged) {
  const srcModules = path.join(SRC_ROOT, "node_modules");
  if (fs.existsSync(srcModules)) {
    syncDirClean(srcModules, dstModules);
  }
  if (fs.existsSync(srcLock)) {
    fs.copyFileSync(srcLock, dstLock);
  }
}

console.log(`Installed Trajectory Lens plugin to ${DEST_ROOT}`);
await refreshAntigravityMcp();
