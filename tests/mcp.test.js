import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { configure } from "../src/profile.js";
import { cli, fixture } from "./helpers.js";

test("real stdio MCP exposes typed CRUD, refuses owner injection, reports failures and revocation", async (t) => {
  const f = await fixture(t);
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env: {
      DALIAO_PROFILE: f.profilePath,
      DALIAO_USER_ID: "1",
      DALIAO_ORIGIN: f.baseUrl,
    },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, "daliao-bridge");
  const { tools } = await client.listTools();
  assert.equal(tools.length, 18);
  assert.match(tools[0].description, new RegExp(f.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(
    tools.find((tool) => tool.name === "asr_health").annotations.readOnlyHint,
    true,
  );
  assert.deepEqual(
    tools.find((tool) => tool.name === "transcribe_audio").inputSchema.required,
    ["audio_path"],
  );
  assert.equal(
    tools.find((tool) => tool.name === "delete_project").annotations
      .destructiveHint,
    true,
  );
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const who = await call("current_user");
  assert.equal(JSON.parse(who.content[0].text).id, 1);
  assert.equal(JSON.stringify(who).includes(f.token), false);
  const health = await call("asr_health");
  assert.notEqual(health.isError, true);
  assert.equal(f.state.calls.at(-1).path, "/api/asr/health");
  const created = await call("create_project", {
    title: "采访项目",
    category: "访谈",
  });
  assert.equal(JSON.parse(created.content[0].text).title, "采访项目");
  const material = await call("create_material", {
    project_id: 7,
    title: "笔记",
    content: "采访正文",
  });
  assert.equal(JSON.parse(material.content[0].text).content, "采访正文");
  const last = f.state.calls.at(-1);
  assert.equal(last.path, "/api/projects/7/materials");
  assert.equal(last.body.project_id, undefined);
  await call("update_material", {
    material_id: 7,
    changes: { content: "新正文" },
  });
  assert.deepEqual(f.state.calls.at(-1).body, { content: "新正文" });
  const removed = await call("delete_material", { material_id: 7 });
  assert.equal(JSON.parse(removed.content[0].text).deleted, true);
  const failure = await call("get_project", { project_id: 999 });
  assert.equal(failure.isError, true);
  const before = f.state.calls.length;
  const injected = await call("create_project", {
    title: "Attack",
    user_id: 2,
  });
  assert.equal(injected.isError, true);
  assert.equal(f.state.calls.length, before);
  await call("list_materials", { project_id: 7, page: 2 });
  assert.equal(
    f.state.calls.at(-1).path,
    "/api/projects/7/materials?page=2&page_size=100",
  );
  f.state.revoked = true;
  const revoked = await call("create_project", { title: "No write" });
  assert.equal(revoked.isError, true);
  assert.equal(f.state.calls.at(-1).path, "/api/integrations/me");
  assert.equal(JSON.stringify(revoked).includes(f.token), false);
  assert.equal(JSON.parse(revoked.content[0].text).error.code, "http_401");

  f.state.revoked = false;
  const content = '长正文\n"引文" $(echo no-shell) 😀'.repeat(10000);
  const large = await call("create_material", {
    project_id: 7,
    title: "长素材",
    content,
  });
  assert.notEqual(large.isError, true, large.content[0].text);
  assert.equal(JSON.parse(large.content[0].text).content, content);

  // Save and revise complete result text through ordinary material tools.
  const revised = content + "修订结尾。";
  const saved = await call("update_material", {
    material_id: 7,
    changes: { content: revised },
  });
  assert.notEqual(saved.isError, true, saved.content[0].text);
  assert.equal(JSON.parse(saved.content[0].text).content, revised);
  assert.deepEqual(f.state.calls.at(-1).body, { content: revised });
  assert.equal(f.state.idempotencyKeys.at(-1), undefined);

  const beforeRemoved = f.state.calls.length;
  for (const name of [
    "create_creation_task", "list_creation_tasks", "get_creation_task", "complete_creation_task",
    "get_work", "get_work_version", "edit_work_version", "adopt_work_version", "restore_work_version",
  ]) {
    assert.equal(tools.some((tool) => tool.name === name), false, name);
    await assert.rejects(call(name), (error) =>
      error.code === -32602 && error.message.includes(`Tool ${name} not found`), name);
  }
  assert.equal(f.state.calls.length, beforeRemoved);

  // The CLI must reload credentials on every call, but keep the installed binding.
  const profile = JSON.parse(await readFile(f.profilePath, "utf8"));
  await writeFile(
    f.profilePath,
    JSON.stringify({ ...profile, token: f.otherToken }),
  );
  const changedToken = await call("create_project", { title: "blocked" });
  assert.equal(
    JSON.parse(changedToken.content[0].text).error.code,
    "account_mismatch",
  );
  assert.equal(f.state.calls.at(-1).path, "/api/integrations/me");
  await writeFile(
    f.profilePath,
    JSON.stringify({ ...profile, userId: 2, token: f.otherToken }),
  );
  const count = f.state.calls.length;
  const changedOwner = await call("list_projects");
  assert.equal(
    JSON.parse(changedOwner.content[0].text).error.code,
    "binding_mismatch",
  );
  assert.equal(f.state.calls.length, count);
});

test("active MCP connection follows CLI switches without restarting", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const profiles = join(first.directory, ".cc", "profiles");
  const firstPath = join(profiles, "first.json");
  const secondPath = join(profiles, "second.json");
  await configure(firstPath, first.baseUrl, first.token);
  await configure(secondPath, second.baseUrl, second.token);
  const env = { ...process.env, HOME: first.directory };
  const use = async (path) => {
    const result = await cli(
      ["connections", "use", "local", "--profile", path],
      undefined,
      env,
    );
    assert.equal(result.code, 0, result.error);
  };
  await use(firstPath);

  const client = new Client({ name: "switch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env: { ...env, DALIAO_CONNECTION_MODE: "active" },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  const firstCalls = first.state.calls.length;
  const secondCalls = second.state.calls.length;
  const firstResult = await client.callTool({ name: "current_user", arguments: {} });
  assert.notEqual(firstResult.isError, true);
  assert.equal(first.state.calls.length, firstCalls + 1);
  assert.equal(second.state.calls.length, secondCalls);

  const cloud = await cli(["connections", "use", "cloud"], undefined, env);
  assert.equal(cloud.code, 0, cloud.error);
  assert.equal(JSON.parse(cloud.output).tokenConfigured, false);
  const missingCloud = await client.callTool({ name: "current_user", arguments: {} });
  assert.equal(missingCloud.isError, true);
  assert.equal(
    JSON.parse(missingCloud.content[0].text).error.code,
    "token_not_configured",
  );
  assert.equal(first.state.calls.length, firstCalls + 1);
  assert.equal(second.state.calls.length, secondCalls);

  await use(secondPath);
  const secondResult = await client.callTool({ name: "current_user", arguments: {} });
  assert.notEqual(secondResult.isError, true);
  assert.equal(first.state.calls.length, firstCalls + 1);
  assert.equal(second.state.calls.length, secondCalls + 1);
});
