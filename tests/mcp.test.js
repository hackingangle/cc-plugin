import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture } from "./helpers.js";

test("real stdio MCP exposes typed CRUD, refuses owner injection, reports failures and revocation", async (t) => {
  const f = await fixture(t);
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env: {
      CUIJIAO_PROFILE: f.profilePath,
      CUIJIAO_USER_ID: "1",
      CUIJIAO_ORIGIN: f.baseUrl,
    },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
  assert.equal(
    tools.find((tool) => tool.name === "delete_project").annotations
      .destructiveHint,
    true,
  );
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const who = await call("current_user");
  assert.equal(JSON.parse(who.content[0].text).id, 1);
  assert.equal(JSON.stringify(who).includes(f.token), false);
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
