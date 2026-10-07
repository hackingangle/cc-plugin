// Opt-in local CLI integration. Both harnesses use disposable config directories.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";

const exec = promisify(execFile);
test("Claude Code and Codex install and refresh a generated local plugin in isolated homes", async (t) => {
  const f = await fixture(t);
  const codexDirectory = join(f.directory, "codex");
  const claudeDirectory = join(f.directory, "claude");
  await mkdir(codexDirectory);
  await mkdir(claudeDirectory);
  const env = {
    ...process.env,
    CODEX_HOME: codexDirectory,
    CLAUDE_CONFIG_DIR: claudeDirectory,
  };
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const sync = async () =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [cli, "sync", "--profile", f.profilePath],
          { env, timeout: 120000 },
        )
      ).stdout,
    );
  let result;
  try {
    result = await sync();
  } catch (error) {
    assert.fail(error.stderr || error.message);
  }
  assert.deepEqual(result.installed, ["cc", "codex"]);
  const selector = `${result.namespace}@${result.marketplace}`;
  const claudeList = async () =>
    JSON.parse(
      (await exec("claude", ["plugin", "list", "--json"], { env })).stdout,
    );
  const installed = (await claudeList()).find(
    (plugin) => plugin.id === selector,
  );
  assert.equal(installed.version, result.version);
  assert.equal(installed.enabled, true);
  const codexList = JSON.parse(
    (
      await exec(
        "codex",
        ["plugin", "list", "--marketplace", result.marketplace, "--json"],
        { env },
      )
    ).stdout,
  );
  const codexInstalled = codexList.installed.find(
    (plugin) => plugin.pluginId === selector,
  );
  assert.equal(codexInstalled.version, result.version);
  assert.equal(codexInstalled.enabled, true);
  const codexServers = JSON.parse(
    (await exec("codex", ["mcp", "list", "--json"], { env })).stdout,
  );
  assert.ok(
    JSON.stringify(codexServers).includes("CUIJIAO_PROFILE"),
    "Codex must discover the bundled MCP server",
  );
  const native = join(
    codexDirectory,
    "agents",
    `${result.namespace}-agent-1.toml`,
  );
  await exec(process.env.BRIDGE_TEST_PYTHON || "python3.11", [
    "-c",
    'import sys,tomllib; d=tomllib.load(open(sys.argv[1],"rb")); assert d["name"] and d["developer_instructions"] and d["mcp_servers"]',
    native,
  ]);
  f.state.agents = [];
  const next = await sync();
  assert.notEqual(result.version, next.version);
  const updated = (await claudeList()).find((plugin) => plugin.id === selector);
  assert.equal(updated.version, next.version);
  assert.deepEqual(await readdir(join(updated.installPath, "agents")), [
    "platform.md",
  ]);
  assert.equal((await readdir(join(codexDirectory, "agents"))).length, 1);
  const config = await readFile(join(codexDirectory, "config.toml"), "utf8");
  assert.equal(config.includes(f.token), false);
  assert.equal(config.includes(result.namespace), true);
});
