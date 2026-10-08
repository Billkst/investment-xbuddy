import test from "node:test";
import assert from "node:assert/strict";
import {
  newWorkspace,
  readWorkspaceToken,
  workspaceOwner,
} from "../lib/research/workspace.ts";

test("HTTPS workspace cookie is host-only, HttpOnly, Secure and carries 256 bits of randomness", async () => {
  const a = await newWorkspace("https://example.test/");
  const b = await newWorkspace("https://example.test/");
  assert.notEqual(a.owner, b.owner);
  assert.match(
    a.cookie,
    /^__Host-xbuddy-workspace=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure$/,
  );
  assert.match(a.owner, /^anon_v1_[a-f0-9]{64}$/);
  assert.ok(!a.cookie.includes("Domain="));
  const token = readWorkspaceToken(
    new Request("https://example.test/api/research", {
      headers: { Cookie: a.cookie.split(";")[0] },
    }),
  );
  assert.ok(token);
  assert.equal(await workspaceOwner(token), a.owner);
  assert.ok(!a.owner.includes(token));
});

test("malformed, duplicated and development cookies cannot authorize an HTTPS workspace", () => {
  const cookie = "__Host-xbuddy-workspace=" + "a".repeat(64);
  for (const value of [
    "",
    cookie + "; " + cookie,
    "__Host-xbuddy-workspace=bad",
    "xbuddy-workspace-dev=" + "a".repeat(64),
  ]) {
    assert.equal(
      readWorkspaceToken(
        new Request("https://example.test/api/research", {
          headers: { Cookie: value },
        }),
      ),
      null,
    );
  }
});

test("local HTTP uses a separate cookie without relying on ChatGPT headers", async () => {
  const workspace = await newWorkspace("http://127.0.0.1:5173");
  assert.match(workspace.cookie, /^xbuddy-workspace-dev=/);
  assert.ok(!workspace.cookie.includes("Secure"));
  const request = new Request("http://127.0.0.1:5173/api/research", {
    headers: {
      "oai-authenticated-user-id": "test-user",
      "oai-authenticated-user-email": "user@example.test",
    },
  });
  assert.equal(readWorkspaceToken(request), null);
});
