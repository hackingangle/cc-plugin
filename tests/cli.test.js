import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cli, fixture } from "./helpers.js";

test("CLI covers identity and all project, material and agent operations with correct HTTP routes and bodies", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["whoami", {}, "GET", "/api/integrations/me"],
    ["projects list", {}, "GET", "/api/projects"],
    ["projects get", { project_id: 7 }, "GET", "/api/projects/7"],
    [
      "projects create",
      { title: "采访", category: "访谈", episode_no: 2 },
      "POST",
      "/api/projects",
      { title: "采访", category: "访谈", episode_no: 2 },
    ],
    [
      "projects update",
      { project_id: 7, changes: { title: "新标题" } },
      "PATCH",
      "/api/projects/7",
      { title: "新标题" },
    ],
    ["projects delete", { project_id: 7 }, "DELETE", "/api/projects/7"],
    [
      "materials list",
      { project_id: 7, page: 2 },
      "GET",
      "/api/projects/7/materials?page=2&page_size=100",
    ],
    ["materials get", { material_id: 8 }, "GET", "/api/materials/8"],
    [
      "materials create",
      {
        project_id: 7,
        title: "原文",
        content: "正文",
        origin_url: "https://example.com",
      },
      "POST",
      "/api/projects/7/materials",
      { title: "原文", content: "正文", origin_url: "https://example.com" },
    ],
    [
      "materials update",
      { material_id: 8, changes: { content: "" } },
      "PATCH",
      "/api/materials/8",
      { content: "" },
    ],
    ["materials delete", { material_id: 8 }, "DELETE", "/api/materials/8"],
    ["agents list", {}, "GET", "/api/agents"],
    ["agents get", { agent_id: 9 }, "GET", "/api/agents/9"],
    [
      "agents create",
      { name: "作者", system_prompt: "保留引文" },
      "POST",
      "/api/agents",
      { name: "作者", system_prompt: "保留引文" },
    ],
    [
      "agents update",
      { agent_id: 9, changes: { description: null } },
      "PATCH",
      "/api/agents/9",
      { description: null },
    ],
    ["agents delete", { agent_id: 9 }, "DELETE", "/api/agents/9"],
  ];
  for (const [command, input, method, path, body] of cases) {
    f.state.calls.length = 0;
    const result = await cli([
      ...command.split(" "),
      "--profile",
      f.profilePath,
      "--input",
      JSON.stringify(input),
    ]);
    assert.equal(result.code, 0, `${command}: ${result.error}`);
    assert.equal(result.error, "");
    const data = JSON.parse(result.output);
    assert.deepEqual(f.state.calls[0], {
      method: "GET",
      path: "/api/integrations/me",
      body: undefined,
    });
    assert.equal(f.state.calls.length, command === "whoami" ? 1 : 2);
    assert.deepEqual(f.state.calls.at(-1), { method, path, body }, command);
    if (method === "DELETE") assert.deepEqual(data, { deleted: true });
    assert.equal(result.output.includes(f.token), false);
  }
});

test("CLI accepts file and stdin JSON without shell interpretation or argument-size limits", async (t) => {
  const f = await fixture(t);
  const content = '正文\n"引文" \\路径 $(echo secret) `echo secret` 😀'.repeat(
    5000,
  );
  const input = { project_id: 7, title: "长素材", content };
  const path = join(f.directory, "material input.json");
  await writeFile(path, JSON.stringify(input));
  for (const options of [["--input-file", path], ["--input-stdin"]]) {
    const result = await cli(
      ["materials", "create", "--profile", f.profilePath, ...options],
      JSON.stringify(input),
    );
    assert.equal(result.code, 0, result.error);
    assert.equal(JSON.parse(result.output).content, content);
    assert.equal(f.state.calls.at(-1).body.content, content);
  }
});

test("CLI rejects malformed inputs and unsafe options before HTTP; returns sanitized JSON failures", async (t) => {
  const f = await fixture(t);
  const invalid = [
    ["projects", "create", "--input", "{"],
    ["projects", "create", "--input", "null"],
    [
      "projects",
      "create",
      "--input",
      JSON.stringify({ title: "x", user_id: 2 }),
    ],
    ["projects", "get", "--input", JSON.stringify({ project_id: "7" })],
    ["projects", "get", "--input", JSON.stringify({ project_id: 0 })],
    [
      "projects",
      "update",
      "--input",
      JSON.stringify({ project_id: 7, changes: {} }),
    ],
    [
      "materials",
      "list",
      "--input",
      JSON.stringify({ project_id: 7, page_size: 101 }),
    ],
    ["projects", "delete", "--input", '{"project_id":7}', "--dry-run"],
    ["projects", "list", "--input", "{}", "--input-stdin"],
    ["projects", "list", "--token", f.token],
    ["projects", "list", "--input-file", join(f.directory, "missing.json")],
    ["projects", "unknown"],
    ["projects", "unknown", "--help"],
  ];
  for (const args of invalid) {
    const result = await cli([...args, "--profile", f.profilePath]);
    assert.equal(result.code, 1);
    assert.equal(result.output, "");
    assert.equal(JSON.parse(result.error).error.code, "invalid_arguments");
    assert.equal(result.error.includes(f.token), false);
    assert.equal(f.state.calls.length, 0);
  }
  const missing = await cli([
    "projects",
    "get",
    "--profile",
    f.profilePath,
    "--input",
    '{"project_id":999}',
  ]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.error).error.code, "http_404");
  f.state.calls.length = 0;
  f.state.revoked = true;
  const revoked = await cli([
    "projects",
    "create",
    "--profile",
    f.profilePath,
    "--input",
    '{"title":"blocked"}',
  ]);
  assert.equal(revoked.code, 1);
  assert.equal(revoked.output, "");
  assert.equal(JSON.parse(revoked.error).error.code, "http_401");
  assert.equal(revoked.error.includes(f.token), false);
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.calls[0].path, "/api/integrations/me");
});

test("CLI help discovers commands and schemas without a connection", async () => {
  const result = await cli(["--help", "--json"]);
  assert.equal(result.code, 0, result.error);
  const commands = JSON.parse(result.output).commands;
  assert.equal(commands.length, 16);
  const materials = commands.find(
    (command) => command.command === "materials create",
  );
  assert.equal(materials.tool, "create_material");
  assert.deepEqual(materials.inputSchema.required, [
    "project_id",
    "title",
    "content",
  ]);
  assert.equal(materials.inputSchema.additionalProperties, false);
});
