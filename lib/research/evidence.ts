import type { Evidence } from "./types.ts";
// Positive allowlist: new quality states must never become facts by accident.
export function usableEvidence(e: Evidence): boolean {
  return (
    ["verified", "demo"].includes(e.quality) &&
    e.evidenceKind !== "discovery" &&
    (e.value !== null || !!e.text?.trim())
  );
}
export function numericEvidence(e: Evidence): boolean {
  return usableEvidence(e) && e.value !== null && !e.text;
}
export function safeSourceUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
