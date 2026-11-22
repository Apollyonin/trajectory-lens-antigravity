import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcEntry = path.join(__dirname, "src", "app.ts");
const cssEntry = path.join(__dirname, "src", "styles.css");
const outDir = path.join(__dirname, "dist");
const outHtml = path.join(outDir, "app.html");

const result = await esbuild.build({
  entryPoints: [srcEntry],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  charset: "utf8",
});

const jsBundle = result.outputFiles[0].text;
const cssRaw = fs.readFileSync(cssEntry, "utf8");

// Prevent accidental inline tag termination inside self-contained HTML
const safeCss = cssRaw.replace(/<\/style/gi, "<\\/style");
const safeJs = jsBundle.replace(/<\/script/gi, "<\\/script");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Trajectory Lens</title>
  <style>${safeCss}</style>
</head>
<body>
  <div id="root"></div>
  <script>${safeJs}</script>
</body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outHtml, html, "utf8");
const bytes = Buffer.byteLength(html, "utf8");
if (bytes >= 10 * 1024 * 1024) {
  throw new Error(`Built app.html (${bytes} bytes) exceeds 10 MiB MCP App limit.`);
}
console.log(`Built ${outHtml} (${(bytes / 1024).toFixed(1)} KiB)`);
