import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, fixture } from "./helpers.js";

const cloudOrigin = "https://cc.agoodbit.com";
const localOrigin = "http://localhost:8080";

function isolatedEnv(directory) {
  const env = { ...process.env, HOME: directory };
  delete env.CUIJIAO_PROFILE;
  delete env.CUIJIAO_ORIGIN;
  delete env.CUIJIAO_USER_ID;
  return env;
}

async function freshHome(t) {
  const directory = await mkdtemp(join(tmpdir(), "cuijiao-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, env: isolatedEnv(directory) };
}

async function successful(args, env, input) {
  const response = await cli(args, input, env);
  assert.equal(response.code, 0, response.error);
  return JSON.parse(response.output);
}

async function rejectsWith(args, env, code) {
  const response = await cli(args, undefined, env);
  assert.equal(response.code, 1, response.output);
  assert.equal(response.output, "");
  assert.equal(JSON.parse(response.error).error.code, code);
}

async function saveProfile(directory, name, profile) {
  const profiles = join(directory, ".config", "cuijiao-bridge", "profiles");
  await mkdir(profiles, { recursive: true });
  const path = join(profiles, name);
  await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
  return path;
}

test("environment selection persists without a Token, while business commands require one", async (t) => {
  const { directory, env } = await freshHome(t);
  const initial = await successful(["connections", "current"], env);
  assert.equal(initial.environment, "cloud");
  assert.equal(initial.origin, cloudOrigin);
  assert.equal(initial.tokenConfigured, false);
  await rejectsWith(["whoami"], env, "token_not_configured");
  await rejectsWith(["sync", "--harness", "codex", "--dry-run"], env, "token_not_configured");

  for (const [environment, origin] of [["local", localOrigin], ["cloud", cloudOrigin]]) {
    const selected = await successful(["connections", "use", environment], env);
    assert.equal(selected.environment, environment);
    assert.equal(selected.origin, origin);
    assert.equal(selected.tokenConfigured, false);
    const current = await successful(["connections", "current"], env);
    assert.equal(current.environment, environment);
    assert.equal(current.origin, origin);
    assert.equal(current.tokenConfigured, false);
  }
  const activePath = join(directory, ".cc", "active.json");
  assert.equal((await stat(activePath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(activePath, "utf8")).environment, "cloud");
});

test("an unconfigured selected environment never falls back to another environment's Token", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  await saveProfile(f.directory, "local.json", JSON.parse(await readFile(f.profilePath, "utf8")));
  await successful(["connections", "use", "local"], env);
  assert.equal((await successful(["whoami"], env)).id, 1);
  const calls = f.state.calls.length;

  const selected = await successful(["connections", "use", "cloud"], env);
  assert.equal(selected.tokenConfigured, false);
  await rejectsWith(["whoami"], env, "token_not_configured");
  await rejectsWith(["sync", "--harness", "codex", "--dry-run"], env, "token_not_configured");
  assert.equal(f.state.calls.length, calls);
  assert.equal((await successful(["whoami", "--profile", f.profilePath], env)).id, 1);
  assert.equal((await successful(["connections", "current"], env)).environment, "cloud");
});

test("configuring a Token after selection resolves it on the next CLI call", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  const selected = await successful(["connections", "use", "local"], env);
  assert.equal(selected.tokenConfigured, false);
  const path = join(f.directory, ".cc", "profiles", "later.json");
  await successful(
    ["configure", "--url", f.baseUrl, "--profile", path, "--token-stdin"],
    env,
    f.token,
  );
  const current = await successful(["connections", "current"], env);
  assert.equal(current.environment, "local");
  assert.equal(current.origin, f.baseUrl);
  assert.equal(current.profilePath, path);
  assert.equal(current.tokenConfigured, true);
  assert.equal((await successful(["whoami"], env)).id, 1);
});

test("multiple target profiles permit selection but require disambiguation for business commands", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  const profile = JSON.parse(await readFile(f.profilePath, "utf8"));
  const first = await saveProfile(f.directory, "first.json", profile);
  await saveProfile(f.directory, "second.json", { ...profile, userId: 2, token: f.otherToken });

  const selected = await successful(["connections", "use", "local"], env);
  assert.equal(selected.environment, "local");
  assert.equal(selected.tokenConfigured, false);
  assert.equal(selected.profileRequired, true);
  const current = await successful(["connections", "current"], env);
  assert.equal(current.profileRequired, true);
  const calls = f.state.calls.length;
  await rejectsWith(["whoami"], env, "connection_ambiguous");
  await rejectsWith(["sync", "--harness", "codex", "--dry-run"], env, "connection_ambiguous");
  assert.equal(f.state.calls.length, calls);

  const pinned = await successful(["connections", "use", "local", "--profile", first], env);
  assert.equal(pinned.tokenConfigured, true);
  assert.equal(pinned.profilePath, first);
  assert.equal((await successful(["whoami"], env)).id, 1);
  await writeFile(first, JSON.stringify({ ...profile, userId: 2, token: f.otherToken }));
  const beforeChangedBinding = f.state.calls.length;
  await rejectsWith(["whoami"], env, "binding_mismatch");
  assert.equal(f.state.calls.length, beforeChangedBinding);
  await writeFile(first, JSON.stringify({ ...profile, baseUrl: "http://localhost:8081" }));
  await rejectsWith(["whoami"], env, "binding_mismatch");
  assert.equal(f.state.calls.length, beforeChangedBinding);
});

test("explicit profile selection validates the target before replacing the saved environment", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  await successful(["connections", "use", "cloud"], env);
  await rejectsWith(
    ["connections", "use", "cloud", "--profile", f.profilePath],
    env,
    "invalid_arguments",
  );
  const missing = await cli(
    ["connections", "use", "local", "--profile", join(f.directory, "missing.json")],
    undefined,
    env,
  );
  assert.equal(missing.code, 1);
  assert.equal((await successful(["connections", "current"], env)).environment, "cloud");
});

test("legacy active state retains its profile and account binding", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  const directory = join(f.directory, ".config", "cuijiao-bridge");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "active.json"),
    JSON.stringify({ profilePath: f.profilePath, origin: f.baseUrl, userId: 1 }),
    { mode: 0o600 },
  );
  const current = await successful(["connections", "current"], env);
  assert.equal(current.environment, "local");
  assert.equal(current.origin, f.baseUrl);
  assert.equal(current.profilePath, f.profilePath);
  assert.equal(current.tokenConfigured, true);
  assert.equal((await successful(["whoami"], env)).id, 1);
});
