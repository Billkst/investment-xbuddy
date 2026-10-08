// An anonymous browser capability, unrelated to ChatGPT or any user account.
// Only a hash is persisted; the opaque value is HttpOnly and never returned in JSON.
export const WORKSPACE_MAX_AGE = 365 * 24 * 60 * 60;
export function workspaceCookieName(url: string) {
  return new URL(url).protocol === "https:"
    ? "__Host-xbuddy-workspace"
    : "xbuddy-workspace-dev";
}
export function readWorkspaceToken(request: Request): string | null {
  const name = workspaceCookieName(request.url);
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function workspaceOwner(token: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return (
    "anon_v1_" +
    Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export async function newWorkspace(url: string) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    owner: await workspaceOwner(token),
    expiresAt: Date.now() + WORKSPACE_MAX_AGE * 1000,
    cookie: `${workspaceCookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WORKSPACE_MAX_AGE}${new URL(url).protocol === "https:" ? "; Secure" : ""}`,
  };
}
