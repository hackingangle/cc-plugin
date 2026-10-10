// Real CLI processes and a real local backend; no model, MCP or harness process.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cli } from "./helpers.js";
import { platformFixture } from "./platform-helpers.js";

test("standalone CLI closes business workflows against the real platform", async (t) => {
  const { origin, directory, password, sessions, api } =
    await platformFixture(t);
  const tokens = [];
  const profiles = [];
  // Node is launched by absolute path. No model keys, harness configuration or
  // executable search path are inherited by the CLI under test.
  const env = { PATH: directory };
  for (let index = 0; index < 2; index++) {
    const session = await api(
      "POST",
      "/api/auth/register",
      undefined,
      {
        username: `cli_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        password,
      },
      201,
    );
    sessions.push(session);
    const token = await api(
      "POST",
      "/api/tokens",
      session.token,
      { name: "CLI lifecycle test" },
      201,
    );
    tokens.push(token);
    const profile = join(directory, `user-${index}.json`);
    profiles.push(profile);
    const configured = await cli(
      ["configure", "--url", origin, "--profile", profile, "--token-stdin"],
      token.token,
      env,
    );
    assert.equal(configured.code, 0, configured.error);
    assert.equal(configured.error, "");
    assert.equal(configured.output.includes(token.token), false);
    assert.equal(JSON.parse(configured.output).user.id, session.user.id);
  }

  async function invoke(command, input = {}, user = 0, inputFile) {
    const options = inputFile ? ["--input-file", inputFile] : ["--input-stdin"];
    const result = await cli(
      [...command.split(" "), "--profile", profiles[user], ...options],
      inputFile ? undefined : JSON.stringify(input),
      env,
    );
    for (const token of tokens)
      assert.equal(
        (result.output + result.error).includes(token.token),
        false,
        "CLI must not expose credentials",
      );
    return result;
  }
  async function run(command, input, user, inputFile) {
    const result = await invoke(command, input, user, inputFile);
    assert.equal(result.code, 0, `${command}: ${result.error}`);
    assert.equal(result.error, "", command);
    return JSON.parse(result.output);
  }
  async function fails(command, input, code, user = 0) {
    const result = await invoke(command, input, user);
    assert.equal(result.code, 1, command);
    assert.equal(result.output, "", command);
    assert.equal(JSON.parse(result.error).error.code, code, command);
  }
  for (let user = 0; user < sessions.length; user++)
    assert.equal((await run("whoami", {}, user)).id, sessions[user].user.id);

  await t.test(
    "project: create → list/get → update → read persisted fields → delete → absent",
    async () => {
      assert.deepEqual(await run("projects list"), []);
      const project = await run("projects create", {
        title: "采访项目",
        category: "访谈",
        episode_no: 3,
      });
      assert.ok(Number.isSafeInteger(project.id) && project.id > 0);
      assert.deepEqual(
        (await run("projects list")).map((item) => item.id),
        [project.id],
      );
      const input = { project_id: project.id };
      assert.equal((await run("projects get", input)).title, "采访项目");
      await run("projects update", {
        ...input,
        changes: { title: "修订项目" },
      });
      const persisted = await run("projects get", input);
      assert.equal(persisted.title, "修订项目");
      assert.equal(persisted.category, "访谈");
      assert.equal(persisted.episode_no, 3);
      assert.deepEqual(await run("projects delete", input), { deleted: true });
      await fails("projects get", input, "http_404");
      assert.deepEqual(await run("projects list"), []);
    },
  );

  await t.test(
    "materials: file input → pagination → update/read full text → delete and project cascade",
    async () => {
      const project = await run("projects create", { title: "素材闭环" });
      const projectInput = { project_id: project.id };
      const content = '第一段事实。\n"中文引文" 😀\n'.repeat(2000);
      const path = join(directory, "material input.json");
      await writeFile(
        path,
        JSON.stringify({ ...projectInput, title: "采访原文", content }),
      );
      const first = await run("materials create", undefined, 0, path);
      const second = await run("materials create", {
        ...projectInput,
        title: "补充记录",
        content: "第二份事实。",
      });
      assert.notEqual(first.id, second.id);
      const pages = [];
      for (const page of [1, 2]) {
        const result = await run("materials list", {
          ...projectInput,
          page,
          page_size: 1,
        });
        assert.equal(result.total, 2);
        assert.equal(result.page, page);
        assert.equal(result.page_size, 1);
        assert.equal(result.items.length, 1);
        pages.push(result.items[0].id);
      }
      assert.deepEqual(
        pages.sort((a, b) => a - b),
        [first.id, second.id].sort((a, b) => a - b),
      );
      const input = { material_id: first.id };
      const original = await run("materials get", input);
      assert.equal(original.content, content);
      assert.equal(original.source, "api");
      const revised = "修订后的事实。\n保留中文和 emoji 😀";
      await run("materials update", {
        ...input,
        changes: { content: revised },
      });
      const persisted = await run("materials get", input);
      assert.equal(persisted.content, revised);
      assert.equal(persisted.title, "采访原文");
      assert.equal(persisted.project_id, project.id);
      assert.deepEqual(await run("materials delete", input), { deleted: true });
      await fails("materials get", input, "http_404");
      const remaining = await run("materials list", projectInput);
      assert.equal(remaining.total, 1);
      assert.deepEqual(
        remaining.items.map((item) => item.id),
        [second.id],
      );
      await run("projects delete", projectInput);
      await fails("projects get", projectInput, "http_404");
      await fails("materials get", { material_id: second.id }, "http_404");
      await fails("materials list", projectInput, "http_404");
    },
  );

  await t.test(
    "agent: create → list/get → update → read persisted prompt → delete → absent",
    async () => {
      assert.deepEqual(await run("agents list"), []);
      const agent = await run("agents create", {
        name: "CLI 作者",
        description: "初版说明",
        system_prompt: "保留事实。",
      });
      const input = { agent_id: agent.id };
      assert.deepEqual(
        (await run("agents list")).map((item) => item.id),
        [agent.id],
      );
      assert.equal(
        (await run("agents get", input)).system_prompt,
        "保留事实。",
      );
      await run("agents update", {
        ...input,
        changes: {
          description: null,
          system_prompt: "核对事实与引文。\n标注疑问。",
        },
      });
      const persisted = await run("agents get", input);
      assert.equal(persisted.system_prompt, "核对事实与引文。\n标注疑问。");
      assert.equal(persisted.description, null);
      assert.equal(persisted.name, "CLI 作者");
      assert.deepEqual(await run("agents delete", input), { deleted: true });
      await fails("agents get", input, "http_404");
      assert.deepEqual(await run("agents list"), []);
    },
  );

  await t.test(
    "cross-user operations fail without mutation; revoked tokens cannot read or write",
    async () => {
      const project = await run("projects create", { title: "私有项目" });
      const material = await run("materials create", {
        project_id: project.id,
        title: "私有素材",
        content: "原文",
      });
      const agent = await run("agents create", {
        name: "私有助手",
        system_prompt: "原始提示词",
      });
      assert.deepEqual(await run("projects list", {}, 1), []);
      assert.deepEqual(await run("agents list", {}, 1), []);
      for (const [group, input, changes] of [
        ["projects", { project_id: project.id }, { title: "越权修改" }],
        ["materials", { material_id: material.id }, { content: "越权修改" }],
        ["agents", { agent_id: agent.id }, { system_prompt: "越权修改" }],
      ]) {
        for (const action of ["get", "update", "delete"])
          await fails(
            `${group} ${action}`,
            action === "update" ? { ...input, changes } : input,
            "http_404",
            1,
          );
      }
      await fails(
        "materials create",
        { project_id: project.id, title: "越权新增", content: "正文" },
        "http_404",
        1,
      );
      assert.equal(
        (await run("projects get", { project_id: project.id })).title,
        "私有项目",
      );
      assert.equal(
        (await run("materials get", { material_id: material.id })).content,
        "原文",
      );
      assert.equal(
        (await run("agents get", { agent_id: agent.id })).system_prompt,
        "原始提示词",
      );
      await api(
        "DELETE",
        `/api/tokens/${tokens[0].id}`,
        sessions[0].token,
        undefined,
        204,
      );
      await fails("whoami", {}, "http_401");
      await fails("projects get", { project_id: project.id }, "http_401");
      await fails("projects create", { title: "失效后不可写入" }, "http_401");
      assert.equal((await run("whoami", {}, 1)).id, sessions[1].user.id);
    },
  );
});
