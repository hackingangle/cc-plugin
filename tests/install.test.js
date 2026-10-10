import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, cli } from "./helpers.js";

test("one install command binds credentials and exports every agent for an MCP harness without logging the token", async (t) => {
  const f = await fixture(t);
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
  const response = await cli(args, f.token);
  assert.equal(response.code, 0, response.error);
  assert.equal((response.output + response.error).includes(f.token), false);
  const result = JSON.parse(response.output);
  assert.equal(result.user.id, 1);
  assert.equal(result.agentCount, 1);
  assert.deepEqual(result.installed, []);
  assert.equal(result.generatedOnly, true);
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, f.token);
  const mcp = JSON.parse(await readFile(result.mcpConfigPath, "utf8"));
  assert.equal(mcp.mcpServers.platform.env.CUIJIAO_PROFILE, path);
  assert.match(
    await readFile(join(result.skillsPath, "agent-1", "SKILL.md"), "utf8"),
    /system|保留|助手|提示/,
  );
  assert.match(
    await readFile(join(result.skillsPath, "platform", "SKILL.md"), "utf8"),
    /current_user/,
  );
  const other = await cli(args, f.otherToken);
  assert.equal(other.code, 1);
  assert.match(other.error, /其他账号/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, f.token);
  const missingTarget = await cli(
    ["install", "--url", f.baseUrl, "--token-stdin"],
    f.token,
  );
  assert.equal(missingTarget.code, 1);
});
