import crypto from "node:crypto";

const SAFE_FIELDS = ["type", "status", "toolName", "tool", "callId", "nativeType", "ok", "reason"];

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

function bounded(value, maxBytes) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - 16)).toString("utf8")}…[truncated]`;
}

export function sanitizeNativeRecord(record, { mode = "digest", maxBytes = 2048 } = {}) {
  const safe = {};
  for (const field of SAFE_FIELDS) {
    if (record?.[field] !== undefined && record[field] !== null) safe[field] = record[field];
  }
  safe.rawDigest = digest(record);
  if (mode === "full") safe.raw = bounded(record, maxBytes);
  return safe;
}

export function crashTail(records, { lines = 30, maxBytes = 4096 } = {}) {
  const count = Number.isFinite(Number(lines)) ? Math.max(0, Math.min(100, Number(lines))) : 30;
  const rows = (records ?? []).slice(-count).map((record) => JSON.stringify(sanitizeNativeRecord(record, { mode: "digest" })));
  return bounded(rows.join("\n"), Math.max(256, Math.min(64 * 1024, Number(maxBytes) || 4096)));
}
