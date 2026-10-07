// Opt-in live smoke: creates disposable users only on an explicitly selected local backend.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { configure } from "../src/profile.js";
import { syncAgents } from "../src/sync.js";

test("live platform: token identity → agent sync → MCP CRUD → cross-user denial → revocation", async (t) => {
  const origin = process.env.BRIDGE_TEST_ORIGIN;
  assert.ok(origin, "Set BRIDGE_TEST_ORIGIN to an isolated localhost backend");
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname),
  );
  const directory = await mkdtemp(join(tmpdir(), "cuijiao-live-"));
  const password = randomUUID();
  const sessions = [];
  const clients = [];
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
    for (const client of clients) await client.close();
    try {
      for (const session of sessions)
        await api("DELETE", "/api/auth/me", session.token, { password }, 204);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const suffix of ["a", "b"]) {
    sessions.push(
      await api(
        "POST",
        "/api/auth/register",
        undefined,
        {
          username: `bridge_${suffix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          password,
        },
        201,
      ),
    );
  }
  const tokens = [];
  const profiles = [];
  for (const [index, session] of sessions.entries()) {
    const issued = await api(
      "POST",
      "/api/tokens",
      session.token,
      { name: "Temporary bridge smoke" },
      201,
    );
    tokens.push(issued);
    const profilePath = join(directory, `user-${index}.json`);
    profiles.push(profilePath);
    await configure(profilePath, origin, issued.token);
    const client = new Client({ name: "live-bridge-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
        env: {
          CUIJIAO_PROFILE: profilePath,
          CUIJIAO_USER_ID: String(session.user.id),
          CUIJIAO_ORIGIN: origin,
        },
        stderr: "pipe",
      }),
    );
  }
  const call = async (index, name, args = {}) =>
    clients[index].callTool({ name, arguments: args });
  const successful = async (name, args) => {
    const result = await call(0, name, args);
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  await successful("create_agent", {
    name: "采访助手",
    system_prompt: "保留事实。",
  });
  await successful("create_agent", {
    name: "写稿助手",
    system_prompt: "根据素材写稿。",
  });
  await call(1, "create_agent", {
    name: "另一个用户",
    system_prompt: "不能同步给其他用户。",
  });
  const synced = await syncAgents({
    profilePath: profiles[0],
    generateOnly: true,
  });
  assert.equal(synced.agentCount, 2);
  const generated = await readFile(
    join(synced.pluginPath, ".mcp.json"),
    "utf8",
  );
  assert.equal(generated.includes(tokens[0].token), false);
  const project = await successful("create_project", { title: "桥接验证项目" });
  const material = await successful("create_material", {
    project_id: project.id,
    title: "采访原文",
    content: "第一段事实。",
  });
  assert.equal(material.source, "api");
  assert.equal((await successful("list_projects", {})).length, 1);
  assert.equal(
    (await successful("list_materials", { project_id: project.id })).total,
    1,
  );
  assert.equal(
    (await successful("get_material", { material_id: material.id })).content,
    "第一段事实。",
  );
  assert.equal(
    (
      await successful("update_material", {
        material_id: material.id,
        changes: { content: "修订事实。" },
      })
    ).content,
    "修订事实。",
  );
  for (const [name, args] of [
    ["get_project", { project_id: project.id }],
    [
      "update_project",
      { project_id: project.id, changes: { title: "越权修改" } },
    ],
    ["delete_project", { project_id: project.id }],
    ["get_material", { material_id: material.id }],
  ])
    assert.equal((await call(1, name, args)).isError, true, name);
  await successful("delete_material", { material_id: material.id });
  await api(
    "DELETE",
    `/api/tokens/${tokens[0].id}`,
    sessions[0].token,
    undefined,
    204,
  );
  assert.equal(
    (await call(0, "get_project", { project_id: project.id })).isError,
    true,
  );
  await assert.rejects(
    syncAgents({ profilePath: profiles[0], generateOnly: true }),
    /撤销/,
  );
});
