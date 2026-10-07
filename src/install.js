import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { BridgeError } from "./client.js";

const execute = promisify(execFile);
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

export async function installPlugin(
  harness,
  { namespace, marketplace, root, pluginPath, version },
) {
  const command = harness === "cc" ? "claude" : "codex";
  const inventory = JSON.parse(
    await run(command, ["plugin", "marketplace", "list", "--json"]),
  );
  const registered = (
    Array.isArray(inventory) ? inventory : inventory.marketplaces
  ).find((item) => item.name === marketplace);
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
}
