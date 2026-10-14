#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  cloudOrigin,
  automaticProfilePath,
  configure,
  currentConnection,
  describeConnection,
  initializeProfiles,
  listConnections,
  readProfile,
  requireCurrentConnection,
  useConnection,
} from "./profile.js";
import { BridgeError, normalizeOrigin, PlatformClient } from "./client.js";
import { syncAgents } from "./sync.js";
import { readToken } from "./token-input.js";
import { commands, executeCommand } from "./commands.js";

const setupCommands = [
  {
    command: "init",
    usage: "init [--json]",
    description: "初始化 ~/.cc 配置，保留已有连接。",
  },
  {
    command: "configure",
    usage: "configure [--url <origin>] [--profile <文件>] [--token-stdin]",
    description: "配置当前目标的 Token，自动保存到 ~/.cc，不切换环境。",
  },
];

async function readInput(values) {
  const sources = [
    values.input !== undefined,
    values["input-file"] !== undefined,
    values["input-stdin"] === true,
  ];
  if (sources.filter(Boolean).length > 1)
    throw new BridgeError(
      "--input、--input-file、--input-stdin 只能选择一个。",
      "invalid_arguments",
    );
  let text = values.input ?? "{}";
  if (values["input-file"] !== undefined) {
    try {
      text = await readFile(values["input-file"], "utf8");
    } catch {
      throw new BridgeError("无法读取输入文件。", "invalid_arguments");
    }
  }
  if (values["input-stdin"]) {
    if (process.stdin.isTTY)
      throw new BridgeError(
        "--input-stdin 需要通过管道提供 JSON。",
        "invalid_arguments",
      );
    text = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) text += chunk;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError("输入必须是有效 JSON。", "invalid_arguments");
  }
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      url: { type: "string" },
      harness: { type: "string" },
      "token-stdin": { type: "boolean" },
      "generate-only": { type: "boolean" },
      "dry-run": { type: "boolean" },
      input: { type: "string" },
      "input-file": { type: "string" },
      "input-stdin": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals.join(" ");
  const connectionCommand =
    positionals[0] === "connections" &&
    ["list", "current", "use"].includes(positionals[1]);
  const operation = commands.find((entry) => entry.cli === command);
  if (values.help || !command) {
    const selected = commands.filter(
      (entry) =>
        !command ||
        entry.cli === command ||
        entry.cli.startsWith(command + " "),
    );
    if (
      command &&
      selected.length === 0 &&
      !["init", "install", "configure", "sync"].includes(command) &&
      !connectionCommand
    )
      throw new BridgeError("未知命令，请运行 --help。", "invalid_arguments");
    const schemas = selected.map((entry) => ({
      command: entry.cli,
      tool: entry.name,
      description: entry.description,
      inputSchema: z.toJSONSchema(entry.schema),
    }));
    if (values.json)
      console.log(
        JSON.stringify({
          commands: schemas,
          setupCommands: setupCommands.filter(
            (entry) => !command || entry.command === command,
          ),
        }, null, 2),
      );
    else {
      if (
        !command ||
        ["init", "install", "configure", "sync"].includes(command) ||
        connectionCommand
      )
        console.log(
          `萃角儿桥接插件\n\ninit\n  初始化 ~/.cc 配置；默认线上，不覆盖已有选择或 Token。\nconfigure [--url <平台 origin>] [--profile <文件>] [--token-stdin]\n  隐藏输入当前目标的 API Token，自动保存到 ~/.cc；不切换环境。\ninstall [--url <平台 origin>] --harness cc|codex|mcp [--token-stdin] [--profile <文件>]\n  默认连接 ${cloudOrigin}；按平台和用户隔离 Token，安装当前工具。\nconnections list [--profile <额外连接文件>]\n  列出已配置的连接，不显示 Token。\nconnections current\n  查看当前目标及 tokenConfigured 状态；未选择时默认线上。\nconnections use local|cloud [--profile <连接文件>]\n  持久切换目标，无须 Token；--profile 可指定已配置的账号连接。\nwhoami [--profile <文件>]\n  验证当前目标的 Token 和账号，缺 Token 时返回 token_not_configured。\nsync [--harness cc|codex|all] [--profile <文件>] [--dry-run | --generate-only]\n  同步当前目标的 Agent；默认安装到两个 harness。`,
        );
      console.log(
        "平台操作：\n" +
          selected
            .map((entry) => `  ${entry.cli}  ${entry.description}`)
            .join("\n"),
      );
      console.log(
        "\n平台业务命令的参数使用 --input '<JSON>'、--input-file <文件> 或 --input-stdin，任选其一。\n业务命令可用 --profile <文件> 覆盖当前连接；成功 JSON 写入 stdout，失败 JSON 写入 stderr，退出码为 1。\n使用 <命令> --help 查看输入格式，--help --json 获取命令与 JSON Schema。",
      );
      if (operation)
        console.log(JSON.stringify(schemas[0].inputSchema, null, 2));
    }
  } else if (operation) {
    const allowed = new Set([
      "profile",
      "input",
      "input-file",
      "input-stdin",
      "json",
    ]);
    if (Object.keys(values).some((name) => !allowed.has(name)))
      throw new BridgeError(
        "平台命令不支持此选项，请运行对应命令 --help。",
        "invalid_arguments",
      );
    const input = await readInput(values);
    const profilePath = values.profile
      ? resolve(values.profile)
      : (await requireCurrentConnection()).profilePath;
    const binding =
      process.env.CUIJIAO_USER_ID !== undefined ||
      process.env.CUIJIAO_ORIGIN !== undefined
        ? {
            userId: process.env.CUIJIAO_USER_ID,
            baseUrl: process.env.CUIJIAO_ORIGIN,
          }
        : undefined;
    const client = new PlatformClient(await readProfile(profilePath, binding));
    console.log(
      JSON.stringify(await executeCommand(operation, input, client), null, 2),
    );
  } else {
    if (
      (!connectionCommand && positionals.length !== 1) ||
      (!["init", "install", "configure", "sync"].includes(command) && !connectionCommand)
    )
      throw new BridgeError("未知命令，请运行 --help。", "invalid_arguments");
    if (
      ["input", "input-file", "input-stdin"].some(
        (name) => values[name] !== undefined,
      )
    )
      throw new BridgeError(
        "此命令不接受平台操作的 JSON 输入。",
        "invalid_arguments",
      );
    const profilePath = values.profile ? resolve(values.profile) : undefined;
    if (command === "init") {
      if (Object.keys(values).some((name) => name !== "json"))
        throw new BridgeError("init 只支持 --json。", "invalid_arguments");
      console.log(JSON.stringify(await initializeProfiles(), null, 2));
    } else if (command === "connections list") {
      if (
        positionals.length !== 2 ||
        Object.keys(values).some((name) => !["profile", "json"].includes(name))
      )
        throw new BridgeError(
          "connections list 只支持 --profile 和 --json。",
          "invalid_arguments",
        );
      console.log(
        JSON.stringify(
          await listConnections(values.profile ? profilePath : undefined),
          null,
          2,
        ),
      );
    } else if (command === "connections current") {
      if (
        positionals.length !== 2 ||
        Object.keys(values).some((name) => name !== "json")
      )
        throw new BridgeError(
          "connections current 不接受其他参数。",
          "invalid_arguments",
        );
      console.log(JSON.stringify(await currentConnection(), null, 2));
    } else if (positionals[0] === "connections" && positionals[1] === "use") {
      if (
        positionals.length !== 3 ||
        Object.keys(values).some((name) => !["profile", "json"].includes(name))
      )
        throw new BridgeError(
          "用法：connections use local|cloud [--profile <文件>]。",
          "invalid_arguments",
        );
      console.log(
        JSON.stringify(
          await useConnection(positionals[2], values.profile ? profilePath : undefined),
          null,
          2,
        ),
      );
    } else if (command === "install") {
      if (values["dry-run"] || values["generate-only"])
        throw new BridgeError(
          "install 不支持预览选项；使用 sync --dry-run，或 install --harness mcp 导出。",
        );
      if (!["cc", "codex", "mcp"].includes(values.harness))
        throw new BridgeError(
          "install 需要 --harness cc、codex 或 mcp；只安装当前工具。",
        );
      const token = await readToken({ fromStdin: values["token-stdin"] });
      const client = new PlatformClient({
        baseUrl: values.url === undefined ? cloudOrigin : values.url,
        token,
      });
      const user = await client.identity();
      const connectionPath =
        profilePath ?? automaticProfilePath(client.baseUrl, user.id);
      await configure(connectionPath, client.baseUrl, token);
      await useConnection(
        describeConnection(client.baseUrl).environment,
        connectionPath,
      );
      const result = await syncAgents({
        profilePath: connectionPath,
        harness: values.harness === "mcp" ? "all" : values.harness,
        generateOnly: values.harness === "mcp",
      });
      console.log(
        JSON.stringify(
          {
            ...result,
            profilePath: connectionPath,
            mcpConfigPath: join(result.pluginPath, ".mcp.json"),
            skillsPath: join(result.pluginPath, "skills"),
          },
          null,
          2,
        ),
      );
    } else if (command === "configure") {
      if (!values.profile) await initializeProfiles();
      const current =
        !values.profile || values.url === undefined
          ? await currentConnection()
          : undefined;
      if (values.url === undefined && current?.profileRequired)
        throw new BridgeError(
          `当前目标存在多个账号连接，请先运行 connections use ${current.environment} --profile <文件> 选择。`,
          "connection_ambiguous",
        );
      const baseUrl = normalizeOrigin(
        values.url === undefined ? current.origin : values.url,
      );
      const token = await readToken({ fromStdin: values["token-stdin"] });
      const binding =
        !values.profile && current?.origin === baseUrl
          ? { userId: current.userId }
          : undefined;
      const user = await configure(profilePath, baseUrl, token, binding);
      const configuredPath =
        profilePath ?? automaticProfilePath(baseUrl, user.id);
      if (!values.profile && current?.origin === baseUrl)
        await useConnection(current.environment, configuredPath);
      console.log(JSON.stringify({ user, profilePath: configuredPath }, null, 2));
    } else if (command === "sync") {
      console.log(
        JSON.stringify(
          await syncAgents({
            profilePath: values.profile
              ? profilePath
              : (await requireCurrentConnection()).profilePath,
            harness: values.harness,
            dryRun: values["dry-run"],
            generateOnly: values["generate-only"],
          }),
          null,
          2,
        ),
      );
    } else throw new BridgeError("未知命令，请运行 --help。");
  }
} catch (error) {
  let failure = {
    code: "operation_failed",
    message: "操作失败，请检查参数、文件权限或 harness 配置（--help 查看用法）。",
  };
  if (error instanceof BridgeError) {
    failure = { code: error.code, message: error.message };
  } else if (error.code?.startsWith("ERR_PARSE_ARGS")) {
    failure.code = "invalid_arguments";
  }
  console.error(JSON.stringify({ error: failure }));
  process.exitCode = 1;
}
