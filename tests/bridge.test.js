import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PlatformClient, normalizeOrigin } from "../src/client.js";
import { configure, readProfile } from "../src/profile.js";
import { syncAgents } from "../src/sync.js";
import { fixture } from "./helpers.js";

test("credentials are private, bound to one origin and owner, and reject sessions", async (t) => {
  const f = await fixture(t);
  assert.equal((await stat(f.profilePath)).mode & 0o777, 0o600);
  await assert.rejects(
    configure(f.profilePath, f.baseUrl, f.otherToken),
    /其他账号/,
  );
  assert.equal((await readProfile(f.profilePath)).token, f.token);
  assert.throws(
    () => new PlatformClient({ baseUrl: f.baseUrl, token: "a".repeat(64) }),
    /API Token/,
  );
  const wrong = new PlatformClient({
    baseUrl: f.baseUrl,
    token: f.otherToken,
    userId: 1,
  });
  await assert.rejects(wrong.identity(), /绑定用户不同/);
  await chmod(f.profilePath, 0o644);
  await assert.rejects(readProfile(f.profilePath), /600/);
});

test("credentials cannot be sent to URL credentials, insecure origins, paths or redirects", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "http://example.com",
    "https://token@example.com",
    "https://example.com/api",
    "https://example.com?token=x",
  ]) {
    assert.throws(() => normalizeOrigin(url));
  }
  const client = new PlatformClient(await readProfile(f.profilePath));
  await assert.rejects(client.request("GET", "//other.example/api"), /无效/);
  await assert.rejects(
    client.request("GET", "/api/projects/301"),
    /失败或超时/,
  );
  assert.equal(
    f.state.calls.some((call) => call.path === "/outside"),
    false,
  );
  f.state.revoked = true;
  await assert.rejects(
    client.identity(),
    (error) =>
      !error.message.includes(f.token) && error.message.includes("撤销"),
  );
});

test("sync exports every agent, updates/removes managed agents, preserves unrelated agents, and contains no token", async (t) => {
  const f = await fixture(t);
  f.state.agents.push({
    id: 2,
    name: '作者 "二"\n---',
    description: null,
    system_prompt: '路径 C:\\text\n正文 "引用"\n三行',
  });
  const codexHome = join(f.directory, "codex");
  const installs = [];
  const options = {
    profilePath: f.profilePath,
    codexHome,
    install: async (target) => {
      installs.push(target);
    },
  };
  const result = await syncAgents(options);
  assert.deepEqual(installs, ["cc", "codex"]);
  assert.equal(result.agentCount, 2);
  const agentDir = join(codexHome, "agents");
  assert.equal((await readdir(agentDir)).length, 3);
  const mcp = await readFile(join(result.pluginPath, ".mcp.json"), "utf8");
  assert.equal(mcp.includes(f.token), false);
  assert.equal(JSON.parse(mcp).mcpServers.platform.env.CUIJIAO_USER_ID, "1");
  const prompt = await readFile(
    join(agentDir, `${result.namespace}-agent-2.toml`),
    "utf8",
  );
  assert.match(prompt, /正文/);
  assert.equal(prompt.includes(f.token), false);
  assert.equal(prompt.includes("model ="), false);
  await writeFile(join(agentDir, "my-own-agent.toml"), "personal");
  f.state.agents = [{ ...f.state.agents[0], system_prompt: "更新后的提示词" }];
  const next = await syncAgents(options);
  assert.notEqual(next.version, result.version);
  assert.deepEqual(
    (await readdir(agentDir)).sort(),
    [
      `${result.namespace}-agent-1.toml`,
      `${result.namespace}-platform.toml`,
      "my-own-agent.toml",
    ].sort(),
  );
  assert.match(
    await readFile(join(agentDir, `${result.namespace}-agent-1.toml`), "utf8"),
    /更新后的提示词/,
  );
  f.state.agents = [];
  await syncAgents(options);
  assert.equal((await readdir(agentDir)).length, 2);
});

test("failed/invalid fetch and native collisions do not delete existing installation", async (t) => {
  const f = await fixture(t);
  const codexHome = join(f.directory, "codex");
  const options = {
    profilePath: f.profilePath,
    codexHome,
    harness: "codex",
    install: async () => {},
  };
  const result = await syncAgents(options);
  const path = join(codexHome, "agents", `${result.namespace}-agent-1.toml`);
  const before = await readFile(path, "utf8");
  f.state.failAgents = true;
  await assert.rejects(syncAgents(options), /HTTP 503/);
  assert.equal(await readFile(path, "utf8"), before);
  f.state.failAgents = false;
  f.state.agents = [
    {
      id: "../../escape",
      name: "bad",
      description: null,
      system_prompt: "bad",
    },
  ];
  await assert.rejects(syncAgents(options), /列表格式/);
  assert.equal(await readFile(path, "utf8"), before);
  f.state.agents = [];
  await writeFile(path, "handwritten");
  await assert.rejects(syncAgents(options), /非托管/);
  assert.equal(await readFile(path, "utf8"), "handwritten");
});

test("dry-run does not write, generate-only does not install or touch harness files", async (t) => {
  const f = await fixture(t);
  const options = {
    profilePath: f.profilePath,
    install: async () => assert.fail("must not install"),
  };
  await syncAgents({ ...options, dryRun: true });
  assert.deepEqual(await readdir(f.directory), ["profile.json"]);
  const result = await syncAgents({ ...options, generateOnly: true });
  assert.deepEqual(result.installed, []);
  assert.equal(
    JSON.parse(
      await readFile(
        join(result.pluginPath, ".claude-plugin/plugin.json"),
        "utf8",
      ),
    ).name,
    result.namespace,
  );
});
