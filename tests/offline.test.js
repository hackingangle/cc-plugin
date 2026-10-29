import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { syncAgents } from "../src/sync.js";
import { cli } from "./helpers.js";
import { fakeFetch, fakeOrigin, fakeToken } from "./offline-platform.js";

const removedCommands = [
  "creation create", "creation list", "creation get", "creation complete",
  "work get", "work version get", "work edit", "work adopt", "work restore",
];
const removedTools = [
  "create_creation_task", "list_creation_tasks", "get_creation_task", "complete_creation_task",
  "get_work", "get_work_version", "edit_work_version", "adopt_work_version", "restore_work_version",
];

async function offlineFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "daliao-offline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const profilePath = join(directory, "profile.json");
  await writeFile(statePath, JSON.stringify({
    calls: [], nextId: 11, materials: [],
    agents: [{ id: 9, name: "Author", description: "Draft prose", system_prompt: "Keep source facts." }],
  }));
  await writeFile(profilePath, JSON.stringify({ baseUrl: fakeOrigin, token: fakeToken, userId: 1 }), { mode: 0o600 });
  const env = {
    PATH: dirname(process.execPath),
    NODE_OPTIONS: `--import=${new URL("./offline-platform.js", import.meta.url).href}`,
    BRIDGE_TEST_STATE: statePath,
  };
  const state = async () => JSON.parse(await readFile(statePath, "utf8"));
  return { directory, profilePath, statePath, env, state };
}

test("offline CLI removes old commands and saves/revises result text as a material", async (t) => {
  const f = await offlineFixture(t);
  const help = await cli(["--help", "--json"], undefined, f.env);
  assert.equal(help.code, 0, help.error);
  const commands = JSON.parse(help.output).commands;
  assert.equal(commands.length, 18);
  for (const command of removedCommands) {
    assert.equal(commands.some((entry) => entry.command === command), false);
    for (const options of [["--input", "{}"], ["--help", "--json"]]) {
      const rejected = await cli([...command.split(" "), "--profile", f.profilePath, ...options], undefined, f.env);
      assert.equal(rejected.code, 1, command);
      assert.equal(JSON.parse(rejected.error).error.code, "invalid_arguments");
      assert.equal(rejected.output, "");
    }
  }
  assert.deepEqual((await f.state()).calls, []);
  const run = async (command, input = {}) => {
    const result = await cli([...command.split(" "), "--profile", f.profilePath, "--input-stdin"], JSON.stringify(input), f.env);
    assert.equal(result.code, 0, result.error);
    assert.equal((result.output + result.error).includes(fakeToken), false);
    return JSON.parse(result.output);
  };
  assert.equal((await run("whoami")).id, 1);
  assert.equal((await run("agents list"))[0].id, 9);
  const content = 'Full text\n"quote" $(no-shell) 😀'.repeat(5000);
  const created = await run("materials create", { project_id: 7, title: "Result", content });
  assert.equal((await run("materials get", { material_id: created.id })).content, content);
  const revised = content + "\nRevised ending.";
  await run("materials update", { material_id: created.id, changes: { content: revised } });
  const persisted = await run("materials get", { material_id: created.id });
  assert.equal(persisted.content, revised);
  assert.equal(persisted.title, "Result");
  const listed = await run("materials list", { project_id: 7 });
  assert.deepEqual(listed.items.map((entry) => entry.id), [created.id]);
  await run("materials delete", { material_id: created.id });
  const missing = await cli(["materials", "get", "--profile", f.profilePath, "--input", JSON.stringify({ material_id: created.id })], undefined, f.env);
  assert.equal(JSON.parse(missing.error).error.code, "http_404");
  const state = await f.state();
  assert.ok(state.calls.every((call) => !/creation-tasks|\/work/.test(call.path)));
});

test("offline stdio MCP rejects removed tools without API calls and persists material changes via CLI", async (t) => {
  const f = await offlineFixture(t);
  const client = new Client({ name: "offline-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env: { ...f.env, DALIAO_PROFILE: f.profilePath, DALIAO_USER_ID: "1", DALIAO_ORIGIN: fakeOrigin },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 18);
  for (const name of removedTools) {
    assert.equal(tools.some((tool) => tool.name === name), false, name);
    await assert.rejects(client.callTool({ name, arguments: {} }), (error) =>
      error.code === -32602 && error.message.includes(`Tool ${name} not found`), name);
  }
  assert.deepEqual((await f.state()).calls, []);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const content = 'Complete result\n"quote" 😀'.repeat(5000);
  const created = await call("create_material", { project_id: 7, title: "MCP result", content });
  assert.equal((await call("get_material", { material_id: created.id })).content, content);
  await call("update_material", { material_id: created.id, changes: { content: "Revised result" } });
  assert.equal((await call("get_material", { material_id: created.id })).content, "Revised result");
  const state = await f.state();
  const before = state.calls.length;
  const injected = await client.callTool({ name: "create_material", arguments: { project_id: 7, title: "Bad", content: "Bad", user_id: 2 } });
  assert.equal(injected.isError, true);
  assert.equal((await f.state()).calls.length, before);
  state.revoked = true;
  await writeFile(f.statePath, JSON.stringify(state));
  const revoked = await client.callTool({ name: "update_material", arguments: { material_id: created.id, changes: { content: "Blocked" } } });
  assert.equal(revoked.isError, true);
  assert.equal(JSON.parse(revoked.content[0].text).error.code, "http_401");
  assert.equal((await f.state()).materials[0].content, "Revised result");
});

test("offline sync exports material-saving skills and updates managed agents through a fake installer", async (t) => {
  const f = await offlineFixture(t);
  t.mock.method(globalThis, "fetch", fakeFetch(f.statePath));
  const installed = [];
  const options = {
    profilePath: f.profilePath,
    codexHome: join(f.directory, "codex"),
    marketplaceDirectory: join(f.directory, "marketplace"),
    install: async (harness) => installed.push(harness),
  };
  const result = await syncAgents(options);
  assert.deepEqual(installed, ["cc", "codex"]);
  for (const name of ["platform", "agent-9"]) {
    const skill = await readFile(join(result.pluginPath, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, /create_material/);
    assert.match(skill, /update_material/);
    assert.match(skill, /get_material/);
    for (const removed of removedTools) assert.equal(skill.includes(removed), false, removed);
    assert.equal(skill.includes(fakeToken), false);
  }
  const state = await f.state();
  state.agents[0].system_prompt = "Updated prompt";
  await writeFile(f.statePath, JSON.stringify(state));
  await syncAgents(options);
  const native = await readFile(join(options.codexHome, "agents", `${result.namespace}-agent-9.toml`), "utf8");
  assert.match(native, /Updated prompt/);
  assert.match(native, /materials create/);
  assert.match(native, /materials update/);
});
