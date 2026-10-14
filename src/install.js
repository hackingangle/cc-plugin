import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { BridgeError } from "./client.js";
import { legacyConfigDirectory, requireCurrentConnection } from "./profile.js";

const execute = promisify(execFile);
const legacyNamespace = /^cuijiao-[0-9a-f]{12}-u[1-9][0-9]*$/;
const legacyMarketplaceDirectory = join(
  legacyConfigDirectory,
  "profiles",
  "marketplaces",
);

async function run(command, args) {
  try {
    return (
      await execute(command, args, {
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new BridgeError(
      `${command} ${args.slice(0, 3).join(" ")} 执行失败。请确认 harness 已安装、版本支持 plugin 命令；修复后重新 sync。`,
    );
  }
}

function marketplacesFrom(inventory) {
  return Array.isArray(inventory) ? inventory : inventory.marketplaces;
}

async function managedLegacyMarketplaces(harness, inventory) {
  const matches = [];
  for (const item of marketplacesFrom(inventory)) {
    const namespace = item.name?.endsWith("-local")
      ? item.name.slice(0, -"-local".length)
      : "";
    if (!legacyNamespace.test(namespace)) continue;
    const source =
      harness === "cc" ? item.path : item.marketplaceSource?.source;
    const expectedRoot = join(legacyMarketplaceDirectory, namespace);
    if (typeof source !== "string") continue;
    try {
      if (!(await lstat(expectedRoot)).isDirectory()) continue;
      if ((await realpath(source)) !== (await realpath(expectedRoot))) continue;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    matches.push({ namespace, marketplace: item.name });
  }
  return matches;
}

async function removeManagedNativeAgents(codexHome, namespace) {
  const directory = join(codexHome, "agents");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const marker = `# Managed by cuijiao-bridge: ${namespace}`;
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(`${namespace}-`) ||
      !entry.name.endsWith(".toml")
    )
      continue;
    const path = join(directory, entry.name);
    const firstLine = (await readFile(path, "utf8")).split("\n", 1)[0];
    if (firstLine === marker) await rm(path);
  }
}

async function retireLegacyPlugins(harness, command, inventory, codexHome) {
  try {
    await requireCurrentConnection();
  } catch (error) {
    if (["token_not_configured", "connection_ambiguous"].includes(error.code))
      return;
    throw error;
  }

  let step = "核对旧插件来源";
  const completed = [];
  try {
    const legacy = await managedLegacyMarketplaces(harness, inventory);
    if (!legacy.length) return;
    step = "读取旧插件列表";
    const listed = JSON.parse(await run(command, ["plugin", "list", "--json"]));
    const installed = harness === "cc" ? listed : listed.installed;
    for (const { namespace, marketplace } of legacy) {
      const selector = `${namespace}@${marketplace}`;
      const exists = installed.some((item) =>
        harness === "cc"
          ? item.id === selector && item.scope === "user"
          : item.pluginId === selector && item.installed,
      );
      if (exists) {
        step = `卸载 ${selector}`;
        await run(
          command,
          harness === "cc"
            ? ["plugin", "uninstall", selector, "--scope", "user", "--keep-data"]
            : ["plugin", "remove", selector, "--json"],
        );
      }
      if (harness === "codex") {
        step = `清理 ${namespace} 的原生 Agent`;
        await removeManagedNativeAgents(codexHome, namespace);
      }
      step = `移除 ${marketplace}`;
      await run(
        command,
        harness === "cc"
          ? ["plugin", "marketplace", "remove", marketplace, "--scope", "user"]
          : ["plugin", "marketplace", "remove", marketplace, "--json"],
      );
      completed.push(selector);
    }
  } catch (error) {
    const done = completed.length ? `已迁移：${completed.join(", ")}。` : "";
    throw new BridgeError(
      `新版插件已安装，但旧插件迁移在「${step}」时失败。${done}请修复后重新 sync。${error.message}`,
    );
  }
}

export async function installPlugin(
  harness,
  { namespace, marketplace, root, pluginPath, version },
  { codexHome = process.env.CODEX_HOME || join(homedir(), ".codex") } = {},
) {
  const command = harness === "cc" ? "claude" : "codex";
  const inventory = JSON.parse(
    await run(command, ["plugin", "marketplace", "list", "--json"]),
  );
  const registered = marketplacesFrom(inventory).find(
    (item) => item.name === marketplace,
  );
  if (registered) {
    const source =
      harness === "cc" ? registered.path : registered.marketplaceSource?.source;
    if (!source || (await realpath(resolve(source))) !== (await realpath(root)))
      throw new BridgeError(`${marketplace} 已指向其他来源，未修改现有配置。`);
  }
  if (harness === "cc") {
    await run(command, ["plugin", "validate", pluginPath, "--strict"]);
    await run(command, [
      "plugin",
      "validate",
      root + "/.claude-plugin/marketplace.json",
      "--strict",
    ]);
  }
  if (!registered)
    await run(command, [
      "plugin",
      "marketplace",
      "add",
      root,
      ...(harness === "cc" ? ["--scope", "user"] : ["--json"]),
    ]);
  const selector = `${namespace}@${marketplace}`;
  if (harness === "cc") {
    const installed = JSON.parse(
      await run(command, ["plugin", "list", "--json"]),
    );
    const exists = installed.some(
      (item) => item.id === selector && item.scope === "user",
    );
    if (registered)
      await run(command, ["plugin", "marketplace", "update", marketplace]);
    await run(command, [
      "plugin",
      exists ? "update" : "install",
      selector,
      "--scope",
      "user",
    ]);
    let current = JSON.parse(
      await run(command, ["plugin", "list", "--json"]),
    ).find((item) => item.id === selector && item.scope === "user");
    if (current && !current.enabled) {
      await run(command, ["plugin", "enable", selector, "--scope", "user"]);
      current = JSON.parse(
        await run(command, ["plugin", "list", "--json"]),
      ).find((item) => item.id === selector && item.scope === "user");
    }
    if (!current?.enabled || current.version !== version)
      throw new BridgeError(
        "Claude Code 未启用预期版本，请检查 plugin list 后重新同步。",
      );
    const cached = await readFile(
      join(current.installPath, ".mcp.json"),
      "utf8",
    );
    if (cached !== (await readFile(join(pluginPath, ".mcp.json"), "utf8")))
      throw new BridgeError("Claude Code 插件缓存未更新，请重新同步。");
  } else {
    await run(command, ["plugin", "add", selector, "--json"]);
    const listed = JSON.parse(
      await run(command, [
        "plugin",
        "list",
        "--marketplace",
        marketplace,
        "--json",
      ]),
    );
    const current = listed.installed?.find(
      (item) => item.pluginId === selector,
    );
    if (!current?.enabled || current.version !== version)
      throw new BridgeError(
        "Codex 未启用预期版本，请检查 plugin list 后重新同步。",
      );
  }
  await retireLegacyPlugins(harness, command, inventory, codexHome);
}
