export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function fmtNum(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function fmtTimeShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDateCompact(isoOrMs: string | number | null | undefined): string {
  if (!isoOrMs) return "—";
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return String(isoOrMs);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}`;
}

export function toFileUri(filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") return null;
  let normalized = filePath.trim().replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2);
    const rest = normalized
      .slice(2)
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `file:///${drive}${rest}`;
  }
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return (
    "file://" +
    normalized
      .split("/")
      .map((seg, i) => (i === 0 ? "" : encodeURIComponent(seg)))
      .join("/")
  );
}

/**
 * Concurrency-limited queue ensuring we never exceed 3 in-flight callServerTool requests
 * (Antigravity enforces a max of 4 in-flight requests per MCP App).
 */
export class ToolCallQueue {
  private maxInFlight = 3;
  private active = 0;
  private waiting: Array<() => void> = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxInFlight) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}
