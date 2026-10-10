import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only account setup, token issuance/revocation and cleanup use HTTP directly.
export async function platformFixture(t) {
  const origin = process.env.BRIDGE_TEST_ORIGIN;
  assert.ok(origin, "Set BRIDGE_TEST_ORIGIN to an isolated localhost backend");
  const url = new URL(origin);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.ok(["http:", "https:"].includes(url.protocol));
  assert.equal(
    url.origin,
    origin,
    "Use a bare origin without credentials or paths",
  );
  const directory = await mkdtemp(join(tmpdir(), "cuijiao-live-"));
  const password = randomUUID();
  const sessions = [];
  const api = async (method, path, token, body, expected) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    assert.equal(response.status, expected, `${method} ${path}`);
    return response.status === 204 ? undefined : response.json();
  };
  t.after(async () => {
    try {
      await Promise.all(
        sessions.map((session) =>
          api("DELETE", "/api/auth/me", session.token, { password }, 204),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { origin, directory, password, sessions, api };
}
