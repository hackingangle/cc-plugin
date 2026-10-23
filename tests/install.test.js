import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloudOrigin } from "../src/profile.js";
import { syncAgents } from "../src/sync.js";
import { fixture, cli } from "./helpers.js";

test("one install command binds credentials and exports every agent for an MCP harness without logging the token", async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, HOME: f.directory };
  const path = join(f.directory, "new-profile.json");
  const args = [
    "install",
    "--url",
    f.baseUrl,
    "--harness",
    "mcp",
    "--profile",
    path,
    "--token-stdin",
  ];
  const response = await cli(args, f.token, env);
  assert.equal(response.code, 0, response.error);
  assert.equal((response.output + response.error).includes(f.token), false);
  const result = JSON.parse(response.output);
  assert.equal(result.user.id, 1);
  assert.equal(result.agentCount, 1);
  assert.equal(result.namespace, "daliao-active");
  assert.equal(result.marketplace, "daliao-active-local");
  assert.equal(
    result.root,
    join(f.directory, ".config", "daliao-bridge", "marketplaces", "daliao-active"),
  );
  assert.deepEqual(result.installed, []);
  assert.equal(result.generatedOnly, true);
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, f.token);
  const mcp = JSON.parse(await readFile(result.mcpConfigPath, "utf8"));
  assert.equal(mcp.mcpServers.platform.env.DALIAO_CONNECTION_MODE, "active");
  assert.match(
    await readFile(join(result.skillsPath, "agent-1", "SKILL.md"), "utf8"),
    /system|保留|助手|提示/,
  );
  assert.match(
    await readFile(join(result.skillsPath, "platform", "SKILL.md"), "utf8"),
    /current_user/,
  );
  const other = await cli(args, f.otherToken, env);
  assert.equal(other.code, 1);
  assert.match(other.error, /其他账号/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, f.token);
  const missingTarget = await cli(
    ["install", "--url", f.baseUrl, "--token-stdin"],
    f.token,
    env,
  );
  assert.equal(missingTarget.code, 1);
  const emptyOrigin = await cli(
    ["install", "--url", "", "--harness", "mcp", "--token-stdin"],
    f.token,
    env,
  );
  assert.equal(emptyOrigin.code, 1);
  assert.match(emptyOrigin.error, /平台地址无效/);
});

test("one plugin uses a persisted connection selection across two origins", async (t) => {
  const local = await fixture(t);
  const cloud = await fixture(t);
  const env = { ...process.env, HOME: local.directory };
  const install = async (f) => {
    const response = await cli(
      ["install", "--url", f.baseUrl, "--harness", "mcp", "--token-stdin"],
      f.token,
      env,
    );
    assert.equal(response.code, 0, response.error);
    return JSON.parse(response.output);
  };
  const first = await install(local);
  const second = await install(cloud);
  assert.equal(dirname(first.profilePath), join(local.directory, ".cc", "profiles"));
  assert.equal(dirname(second.profilePath), join(local.directory, ".cc", "profiles"));
  assert.equal(first.namespace, second.namespace);
  assert.equal(first.pluginPath === second.pluginPath, false);
  assert.notEqual(first.profilePath, second.profilePath);
  assert.equal(first.marketplace, second.marketplace);

  const listed = await cli(["connections", "list"], undefined, env);
  assert.equal(listed.code, 0, listed.error);
  assert.deepEqual(
    JSON.parse(listed.output).connections.map((entry) => entry.origin).sort(),
    [local.baseUrl, cloud.baseUrl].sort(),
  );
  assert.equal(listed.output.includes(local.token), false);
  const selectLocal = await cli(
    ["connections", "use", "local", "--profile", first.profilePath],
    undefined,
    env,
  );
  assert.equal(selectLocal.code, 0, selectLocal.error);
  const whoLocal = await cli(["whoami"], undefined, env);
  const selectCloud = await cli(
    ["connections", "use", "local", "--profile", second.profilePath],
    undefined,
    env,
  );
  assert.equal(selectCloud.code, 0, selectCloud.error);
  const whoCloud = await cli(["whoami"], undefined, env);
  assert.equal(whoLocal.code, 0, whoLocal.error);
  assert.equal(whoCloud.code, 0, whoCloud.error);
  assert.equal(local.state.calls.at(-1).path, "/api/integrations/me");
  assert.equal(cloud.state.calls.at(-1).path, "/api/integrations/me");
  const current = await cli(["connections", "current"], undefined, env);
  assert.equal(JSON.parse(current.output).origin, cloud.baseUrl);
  const activeFile = join(local.directory, ".cc", "active.json");
  assert.equal((await stat(activeFile)).mode & 0o777, 0o600);
  assert.equal((await readFile(activeFile, "utf8")).includes(local.token), false);

  const codexHome = join(local.directory, "codex");
  const options = {
    codexHome,
    marketplaceDirectory: join(local.directory, ".config", "daliao-bridge", "marketplaces"),
    harness: "codex",
    install: async () => {},
  };
  await syncAgents({ ...options, profilePath: first.profilePath });
  await syncAgents({ ...options, profilePath: second.profilePath });
  await syncAgents({ ...options, profilePath: first.profilePath });
  const native = await readFile(join(codexHome, "agents", `${second.namespace}-platform.toml`), "utf8");
  assert.match(native, /DALIAO_CONNECTION_MODE = "active"/);
  assert.equal(native.includes(local.token), false);
});

test("without a saved choice, the CLI defaults to the configured cloud origin", async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, HOME: f.directory };
  const missing = await cli(["connections", "current"], undefined, env);
  assert.equal(missing.code, 0, missing.error);
  assert.equal(JSON.parse(missing.output).environment, "cloud");
  assert.equal(JSON.parse(missing.output).origin, cloudOrigin);
  assert.equal(JSON.parse(missing.output).tokenConfigured, false);

  const directory = join(f.directory, ".cc", "profiles");
  await mkdir(directory, { recursive: true });
  const cloudPath = join(directory, "cloud.json");
  await writeFile(
    cloudPath,
    JSON.stringify({ baseUrl: cloudOrigin, userId: 1, token: f.token }),
    { mode: 0o600 },
  );
  const current = await cli(["connections", "current"], undefined, env);
  assert.equal(current.code, 0, current.error);
  assert.equal(JSON.parse(current.output).origin, cloudOrigin);
  assert.equal(JSON.parse(current.output).profilePath, cloudPath);
  assert.equal(JSON.parse(current.output).tokenConfigured, true);
  await writeFile(
    cloudPath,
    JSON.stringify({ baseUrl: "https://api.agoodbit.com", userId: 1, token: f.token }),
    { mode: 0o600 },
  );
  const mobile = await cli(["connections", "current"], undefined, env);
  assert.equal(JSON.parse(mobile.output).origin, "https://api.agoodbit.com");
  await writeFile(
    cloudPath,
    JSON.stringify({ baseUrl: cloudOrigin, userId: 1, token: f.token }),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "mobile.json"),
    JSON.stringify({ baseUrl: "https://api.agoodbit.com", userId: 1, token: f.token }),
    { mode: 0o600 },
  );
  const preferred = await cli(["connections", "current"], undefined, env);
  assert.equal(JSON.parse(preferred.output).origin, cloudOrigin);

  const local = await cli(
    ["connections", "use", "local", "--profile", f.profilePath],
    undefined,
    env,
  );
  assert.equal(local.code, 0, local.error);
  const selectedLocal = await cli(["connections", "current"], undefined, env);
  assert.equal(JSON.parse(selectedLocal.output).origin, f.baseUrl);
  const cloud = await cli(["connections", "use", "cloud"], undefined, env);
  assert.equal(cloud.code, 0, cloud.error);
  assert.equal(JSON.parse(cloud.output).origin, cloudOrigin);
});
