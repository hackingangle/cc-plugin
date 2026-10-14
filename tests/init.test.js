import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cli, fixture } from "./helpers.js";

const cloudOrigin = "https://cc.agoodbit.com";

function isolatedEnv(directory) {
  const env = { ...process.env, HOME: directory };
  delete env.CUIJIAO_PROFILE;
  delete env.CUIJIAO_ORIGIN;
  delete env.CUIJIAO_USER_ID;
  return env;
}

async function freshHome(t) {
  const directory = await mkdtemp(join(tmpdir(), "cuijiao-init-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, env: isolatedEnv(directory) };
}

async function successful(args, env, input) {
  const response = await cli(args, input, env);
  assert.equal(response.code, 0, response.error);
  return JSON.parse(response.output);
}

async function saveProfile(path, profile) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
}

async function tokenServer(t) {
  const tokens = ["a", "b", "c"].map((letter) => `hd_${letter.repeat(43)}`);
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ path: request.url, credential: request.headers.authorization });
    const token = request.headers.authorization?.slice("Bearer ".length);
    response.setHeader("Content-Type", "application/json");
    if (request.url !== "/api/integrations/me" || !tokens.includes(token)) {
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.end(JSON.stringify({ id: token === tokens[2] ? 2 : 1, username: "alice", nickname: "Alice" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, tokens, calls };
}

test("init creates private ~/.cc storage without credentials and preserves the selected environment", async (t) => {
  const { directory, env } = await freshHome(t);
  const result = await successful(["init"], env);
  const configDirectory = join(directory, ".cc");
  const profilesDirectory = join(configDirectory, "profiles");
  const activePath = join(configDirectory, "active.json");
  assert.equal(result.configDirectory, configDirectory);
  assert.equal(result.profilesDirectory, profilesDirectory);
  assert.equal(result.activeConnectionPath, activePath);
  assert.equal(result.created, true);
  assert.equal(result.connection.environment, "cloud");
  assert.equal(result.connection.origin, cloudOrigin);
  assert.equal(result.connection.tokenConfigured, false);
  assert.equal((await stat(configDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(profilesDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(activePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(profilesDirectory), []);
  assert.deepEqual(JSON.parse(await readFile(activePath, "utf8")), { environment: "cloud" });

  await successful(["connections", "use", "local"], env);
  const selectedState = await readFile(activePath, "utf8");
  const repeated = await successful(["init"], env);
  assert.equal(repeated.created, false);
  assert.equal(repeated.connection.environment, "local");
  assert.equal(await readFile(activePath, "utf8"), selectedState);
  assert.deepEqual(await readdir(profilesDirectory), []);
});

test("init and configure complete a path-free workflow, rotate the same account Token, and preserve binding", async (t) => {
  const { directory, env } = await freshHome(t);
  const service = await tokenServer(t);
  await successful(["init"], env);
  await successful(["connections", "use", "local"], env);
  const configured = await successful(
    ["configure", "--url", service.baseUrl, "--token-stdin"],
    env,
    service.tokens[0],
  );
  assert.equal(dirname(configured.profilePath), join(directory, ".cc", "profiles"));
  assert.equal((await stat(configured.profilePath)).mode & 0o777, 0o600);
  const current = await successful(["connections", "current"], env);
  assert.equal(current.environment, "local");
  assert.equal(current.origin, service.baseUrl);
  assert.equal(current.profilePath, configured.profilePath);
  assert.equal(current.tokenConfigured, true);
  assert.equal((await successful(["whoami"], env)).id, 1);

  const rotated = await successful(["configure", "--token-stdin"], env, service.tokens[1]);
  assert.equal(rotated.profilePath, configured.profilePath);
  assert.equal(JSON.parse(await readFile(rotated.profilePath, "utf8")).token, service.tokens[1]);
  assert.equal((await successful(["whoami"], env)).id, 1);
  assert.equal(service.calls.at(-1).credential, `Bearer ${service.tokens[1]}`);
  const activePath = join(directory, ".cc", "active.json");
  const activeBefore = await readFile(activePath, "utf8");
  const tokenBefore = await readFile(rotated.profilePath, "utf8");
  const rejected = await cli(["configure", "--token-stdin"], service.tokens[2], env);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.output, "");
  assert.equal(JSON.parse(rejected.error).error.code, "account_mismatch");
  assert.equal(await readFile(activePath, "utf8"), activeBefore);
  assert.equal(await readFile(rotated.profilePath, "utf8"), tokenBefore);
  assert.equal((await successful(["whoami"], env)).id, 1);

  const repeated = await successful(["init"], env);
  assert.equal(repeated.created, false);
  assert.equal(repeated.connection.profilePath, configured.profilePath);
  assert.equal(await readFile(rotated.profilePath, "utf8"), tokenBefore);
  const log = JSON.stringify([configured, rotated, repeated]) + rejected.error;
  assert.equal(service.tokens.some((token) => log.includes(token)), false);
});

test("configure with an explicit URL saves another target without switching the selected environment", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  await successful(["init"], env);
  const configured = await successful(["configure", "--url", f.baseUrl, "--token-stdin"], env, f.token);
  const selected = await successful(["connections", "current"], env);
  assert.equal(selected.environment, "cloud");
  assert.equal(selected.origin, cloudOrigin);
  assert.equal(selected.tokenConfigured, false);
  assert.equal(dirname(configured.profilePath), join(f.directory, ".cc", "profiles"));
  assert.equal((await successful(["whoami", "--profile", configured.profilePath], env)).id, 1);
  await successful(["connections", "use", "local"], env);
  assert.equal((await successful(["whoami"], env)).id, 1);
});

test("init carries the legacy selection forward without rewriting its credentials and new state takes priority", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  const legacyPath = join(f.directory, ".config", "cuijiao-bridge", "profiles", "local.json");
  const profileContents = await readFile(f.profilePath, "utf8");
  await saveProfile(legacyPath, JSON.parse(profileContents));
  const legacyStatePath = join(f.directory, ".config", "cuijiao-bridge", "active.json");
  const legacyState = JSON.stringify({ profilePath: legacyPath, origin: f.baseUrl, userId: 1 });
  await writeFile(legacyStatePath, legacyState, { mode: 0o600 });
  const savedCredential = await readFile(legacyPath, "utf8");
  const initialized = await successful(["init"], env);
  assert.equal(initialized.connection.profilePath, legacyPath);
  assert.equal(initialized.connection.environment, "local");
  assert.equal(initialized.connection.tokenConfigured, true);
  assert.equal(await readFile(legacyPath, "utf8"), savedCredential);
  assert.equal(await readFile(legacyStatePath, "utf8"), legacyState);
  assert.equal((await successful(["whoami"], env)).id, 1);

  await writeFile(legacyStatePath, JSON.stringify({ environment: "cloud" }));
  assert.equal((await successful(["connections", "current"], env)).profilePath, legacyPath);
  const configured = await successful(["configure", "--token-stdin"], env, f.token);
  assert.equal(dirname(configured.profilePath), join(f.directory, ".cc", "profiles"));
  assert.equal((await successful(["connections", "current"], env)).profilePath, configured.profilePath);
  assert.equal(await readFile(legacyPath, "utf8"), savedCredential);
  assert.equal((await successful(["whoami"], env)).id, 1);
});

test("invalid new state fails init instead of falling back to a valid legacy selection", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  const legacyStatePath = join(f.directory, ".config", "cuijiao-bridge", "active.json");
  await mkdir(dirname(legacyStatePath), { recursive: true });
  await writeFile(legacyStatePath, JSON.stringify({ profilePath: f.profilePath, origin: f.baseUrl, userId: 1 }), { mode: 0o600 });
  const activePath = join(f.directory, ".cc", "active.json");
  await mkdir(dirname(activePath), { recursive: true, mode: 0o700 });
  await writeFile(activePath, "{invalid", { mode: 0o600 });
  const callsBefore = f.state.calls.length;
  for (const command of [["init"], ["connections", "current"], ["whoami"]]) {
    const response = await cli(command, undefined, env);
    assert.equal(response.code, 1);
    assert.equal(response.output, "");
    assert.equal(JSON.parse(response.error).error.code, "bridge_error");
  }
  assert.equal(await readFile(activePath, "utf8"), "{invalid");
  assert.equal(f.state.calls.length, callsBefore);
});

test("new managed credentials shadow legacy copies while duplicate new files remain ambiguous", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnv(f.directory);
  const profile = JSON.parse(await readFile(f.profilePath, "utf8"));
  const legacyPath = join(f.directory, ".config", "cuijiao-bridge", "profiles", "old.json");
  const currentPath = join(f.directory, ".cc", "profiles", "new.json");
  await saveProfile(legacyPath, profile);
  await saveProfile(currentPath, profile);
  const listed = await successful(["connections", "list"], env);
  assert.deepEqual(listed.connections.map((connection) => connection.profilePath), [currentPath]);
  assert.equal(listed.issues.length, 0);
  await successful(["connections", "use", "local"], env);
  assert.equal((await successful(["whoami"], env)).id, 1);

  await saveProfile(join(f.directory, ".cc", "profiles", "duplicate.json"), profile);
  const duplicates = await successful(["connections", "list"], env);
  assert.equal(duplicates.connections.length, 2);
  const selected = await successful(["connections", "use", "local"], env);
  assert.equal(selected.profileRequired, true);
  const callsBefore = f.state.calls.length;
  const ambiguous = await cli(["whoami"], undefined, env);
  assert.equal(ambiguous.code, 1);
  assert.equal(JSON.parse(ambiguous.error).error.code, "connection_ambiguous");
  const ambiguousConfigure = await cli(["configure", "--token-stdin"], f.token, env);
  assert.equal(ambiguousConfigure.code, 1);
  assert.equal(JSON.parse(ambiguousConfigure.error).error.code, "connection_ambiguous");
  assert.equal(f.state.calls.length, callsBefore);
});
