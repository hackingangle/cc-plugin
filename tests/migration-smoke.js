// Opt-in harness migration checks. All harness state lives in disposable homes.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
import { readProfile } from "../src/profile.js";
import { accountNamespace } from "../src/sync.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const json = (value) => JSON.stringify(value, null, 2) + "\n";

async function legacyFixture(t) {
  const f = await fixture(t);
  const codexHome = join(f.directory, "codex");
  const claudeHome = join(f.directory, "claude");
  const env = {
    ...process.env,
    HOME: f.directory,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  await mkdir(codexHome);
  await mkdir(claudeHome);
  const profile = await readProfile(f.profilePath);
  const namespace = accountNamespace(profile);
  const marketplace = `${namespace}-local`;
  const root = join(
    f.directory,
    ".config",
    "cuijiao-bridge",
    "profiles",
    "marketplaces",
    namespace,
  );
  const plugin = join(root, "versions", "0.1.0-legacy");
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, "skills", "platform"), { recursive: true });
  await writeFile(
    join(root, ".agents", "plugins", "marketplace.json"),
    json({
      name: marketplace,
      plugins: [
        {
          name: namespace,
          source: { source: "local", path: "./versions/0.1.0-legacy" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }),
  );
  await writeFile(
    join(root, ".claude-plugin", "marketplace.json"),
    json({
      name: marketplace,
      description: "Previous account-bound marketplace",
      owner: { name: "Test" },
      plugins: [{ name: namespace, source: "./versions/0.1.0-legacy" }],
    }),
  );
  await writeFile(
    join(plugin, ".codex-plugin", "plugin.json"),
    json({
      name: namespace,
      version: "0.1.0-legacy",
      description: "Previous account-bound plugin",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    }),
  );
  await writeFile(
    join(plugin, ".claude-plugin", "plugin.json"),
    json({
      name: namespace,
      version: "0.1.0-legacy",
      description: "Previous account-bound plugin",
      author: { name: "Test" },
    }),
  );
  await writeFile(
    join(plugin, "skills", "platform", "SKILL.md"),
    "---\nname: platform\ndescription: Previous platform assistant\n---\n\nPrevious assistant.\n",
  );
  await writeFile(join(plugin, ".mcp.json"), json({ mcpServers: {} }));
  return { f, env, codexHome, namespace, marketplace, root };
}

test("Codex sync retires only a managed legacy plugin after active installation", async (t) => {
  const { f, env, codexHome, namespace, marketplace, root } =
    await legacyFixture(t);
  const codex = async (args) =>
    JSON.parse((await exec("codex", args, { env, timeout: 120000 })).stdout);

  await codex(["plugin", "marketplace", "add", root, "--json"]);
  const selector = `${namespace}@${marketplace}`;
  await codex(["plugin", "add", selector, "--json"]);
  const legacyBefore = await codex([
    "plugin",
    "list",
    "--marketplace",
    marketplace,
    "--json",
  ]);
  assert.ok(legacyBefore.installed.some((item) => item.pluginId === selector));

  const nativeDirectory = join(codexHome, "agents");
  await mkdir(nativeDirectory);
  const managedAgent = join(nativeDirectory, `${namespace}-agent-1.toml`);
  const unrelatedAgent = join(nativeDirectory, `${namespace}-notes.toml`);
  const unrelatedContent = '# User-managed file\nname = "keep-me"\n';
  await writeFile(
    managedAgent,
    `# Managed by cuijiao-bridge: ${namespace}\nname = "old-agent"\n`,
  );
  await writeFile(unrelatedAgent, unrelatedContent);
  const profileBefore = await readFile(f.profilePath, "utf8");

  await exec(
    process.execPath,
    [cli, "connections", "use", "local", "--profile", f.profilePath],
    { env },
  );
  const active = JSON.parse(
    (
      await exec(
        process.execPath,
        [cli, "sync", "--harness", "codex", "--profile", f.profilePath],
        { env, timeout: 120000 },
      )
    ).stdout,
  );
  assert.deepEqual(active.installed, ["codex"]);
  assert.equal(active.namespace, "cuijiao-active");

  const pluginsAfter = await codex(["plugin", "list", "--json"]);
  assert.ok(
    pluginsAfter.installed.some(
      (item) => item.pluginId === `${active.namespace}@${active.marketplace}`,
    ),
  );
  assert.equal(
    pluginsAfter.installed.some((item) => item.pluginId === selector),
    false,
  );
  const marketplacesAfter = await codex([
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  assert.equal(
    marketplacesAfter.marketplaces.some((item) => item.name === marketplace),
    false,
  );
  await assert.rejects(readFile(managedAgent, "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(unrelatedAgent, "utf8"), unrelatedContent);
  assert.equal(await readFile(f.profilePath, "utf8"), profileBefore);
});

test("Codex sync preserves the working legacy installation when the selected cloud has no Token", async (t) => {
  const { f, env, codexHome, namespace, marketplace, root } =
    await legacyFixture(t);
  const codex = async (args) =>
    JSON.parse((await exec("codex", args, { env, timeout: 120000 })).stdout);
  const selector = `${namespace}@${marketplace}`;
  await codex(["plugin", "marketplace", "add", root, "--json"]);
  await codex(["plugin", "add", selector, "--json"]);

  const nativeDirectory = join(codexHome, "agents");
  await mkdir(nativeDirectory);
  const managedAgent = join(nativeDirectory, `${namespace}-agent-1.toml`);
  const managedPlatform = join(nativeDirectory, `${namespace}-platform.toml`);
  const agentContent = `# Managed by cuijiao-bridge: ${namespace}\nname = "old-agent"\n`;
  const platformContent = `# Managed by cuijiao-bridge: ${namespace}\nname = "old-platform"\n`;
  await writeFile(managedAgent, agentContent);
  await writeFile(managedPlatform, platformContent);
  const profileBefore = await readFile(f.profilePath, "utf8");

  const cloud = JSON.parse(
    (
      await exec(process.execPath, [cli, "connections", "use", "cloud"], { env })
    ).stdout,
  );
  assert.equal(cloud.environment, "cloud");
  assert.equal(cloud.tokenConfigured, false);
  const active = JSON.parse(
    (
      await exec(
        process.execPath,
        [cli, "sync", "--harness", "codex", "--profile", f.profilePath],
        { env, timeout: 120000 },
      )
    ).stdout,
  );
  assert.deepEqual(active.installed, ["codex"]);
  const pluginsAfter = await codex(["plugin", "list", "--json"]);
  assert.ok(
    pluginsAfter.installed.some(
      (item) => item.pluginId === `${active.namespace}@${active.marketplace}`,
    ),
  );
  assert.ok(pluginsAfter.installed.some((item) => item.pluginId === selector));
  const marketplacesAfter = await codex(["plugin", "marketplace", "list", "--json"]);
  assert.ok(
    marketplacesAfter.marketplaces.some((item) => item.name === marketplace),
  );
  assert.equal(await readFile(managedAgent, "utf8"), agentContent);
  assert.equal(await readFile(managedPlatform, "utf8"), platformContent);
  assert.equal(await readFile(f.profilePath, "utf8"), profileBefore);
  const current = JSON.parse(
    (await exec(process.execPath, [cli, "connections", "current"], { env })).stdout,
  );
  assert.equal(current.environment, "cloud");
  assert.equal(current.tokenConfigured, false);
});

test("Claude Code sync retires a managed legacy plugin after active installation", async (t) => {
  const { f, env, namespace, marketplace, root } = await legacyFixture(t);
  const claude = async (args) =>
    JSON.parse((await exec("claude", args, { env, timeout: 120000 })).stdout);
  await exec(
    "claude",
    ["plugin", "marketplace", "add", root, "--scope", "user"],
    {
      env,
      timeout: 120000,
    },
  );
  const selector = `${namespace}@${marketplace}`;
  await exec("claude", ["plugin", "install", selector, "--scope", "user"], {
    env,
    timeout: 120000,
  });
  const legacyBefore = await claude(["plugin", "list", "--json"]);
  assert.ok(
    legacyBefore.some(
      (item) => item.id === selector && item.scope === "user" && item.enabled,
    ),
  );
  const profileBefore = await readFile(f.profilePath, "utf8");

  await exec(
    process.execPath,
    [cli, "connections", "use", "local", "--profile", f.profilePath],
    { env },
  );
  const active = JSON.parse(
    (
      await exec(
        process.execPath,
        [cli, "sync", "--harness", "cc", "--profile", f.profilePath],
        { env, timeout: 120000 },
      )
    ).stdout,
  );
  assert.deepEqual(active.installed, ["cc"]);
  assert.equal(active.namespace, "cuijiao-active");

  const pluginsAfter = await claude(["plugin", "list", "--json"]);
  assert.ok(
    pluginsAfter.some(
      (item) =>
        item.id === `${active.namespace}@${active.marketplace}` && item.enabled,
    ),
  );
  assert.equal(
    pluginsAfter.some((item) => item.id === selector),
    false,
  );
  const marketplacesAfter = await claude([
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  assert.equal(
    marketplacesAfter.some((item) => item.name === marketplace),
    false,
  );
  assert.equal(await readFile(f.profilePath, "utf8"), profileBefore);
});
