#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { configure, defaultProfile, readProfile } from "./profile.js";
import { BridgeError, PlatformClient } from "./client.js";
import { accountNamespace, syncAgents } from "./sync.js";
import { readToken } from "./token-input.js";
import { commands, executeCommand } from "./commands.js";

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
      !["install", "configure", "sync"].includes(command)
    )
      throw new BridgeError("未知命令，请运行 --help。", "invalid_arguments");
    const schemas = selected.map((entry) => ({
      command: entry.cli,
      tool: entry.name,
      description: entry.description,
      inputSchema: z.toJSONSchema(entry.schema),
    }));
    if (values.json)
      console.log(JSON.stringify({ commands: schemas }, null, 2));
    else {
      if (!command || ["install", "configure", "sync"].includes(command))
        console.log(
          `萃角儿桥接插件\n\ninstall --url <平台 origin> --harness cc|codex|mcp [--token-stdin] [--profile <文件>]\n  按 Token 用户隔离连接并安装当前工具；mcp 生成配置与全部 Agent 技能，需当前工具继续接入。\nconfigure --url <平台 origin> [--profile <文件>] [--token-stdin]\n  隐藏输入 API Token，验证归属后保存为 600 权限的本机文件。\n  脚本可使用 --token-stdin 从管道输入。\nwhoami [--profile <文件>]\n  验证当前 Token 及绑定账号，不显示凭证。\nsync [--harness cc|codex|all] [--profile <文件>] [--dry-run | --generate-only]\n  同步全部平台 Agent 和默认平台助手；默认安装到两个 harness。\n  dry-run 只检查；generate-only 仅生成插件，供手动验收。`,
        );
      console.log(
        "平台操作：\n" +
          selected
            .map((entry) => `  ${entry.cli}  ${entry.description}`)
            .join("\n"),
      );
      console.log(
        "\n参数使用 --input '<JSON>'、--input-file <文件> 或 --input-stdin，任选其一。\n所有命令支持 --profile <文件>；成功 JSON 写入 stdout，失败 JSON 写入 stderr，退出码为 1。\n使用 <命令> --help 查看输入格式，--help --json 获取命令与 JSON Schema。",
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
    const profilePath = resolve(values.profile || defaultProfile);
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
      positionals.length !== 1 ||
      !["install", "configure", "sync"].includes(command)
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
    const profilePath = resolve(values.profile || defaultProfile);
    if (command === "install") {
      if (values["dry-run"] || values["generate-only"])
        throw new BridgeError(
          "install 不支持预览选项；使用 sync --dry-run，或 install --harness mcp 导出。",
        );
      if (!values.url || !["cc", "codex", "mcp"].includes(values.harness))
        throw new BridgeError(
          "install 需要 --url 和 --harness cc、codex 或 mcp；只安装当前工具。",
        );
      const token = await readToken({ fromStdin: values["token-stdin"] });
      const client = new PlatformClient({ baseUrl: values.url, token });
      const user = await client.identity();
      const connectionPath = values.profile
        ? profilePath
        : join(
            dirname(defaultProfile),
            "profiles",
            `${accountNamespace({ baseUrl: client.baseUrl, userId: user.id })}.json`,
          );
      await configure(connectionPath, client.baseUrl, token);
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
      if (!values.url)
        throw new BridgeError("configure 需要 --url。Token 不接受命令行参数。");
      const token = await readToken({ fromStdin: values["token-stdin"] });
      const user = await configure(profilePath, values.url, token.trim());
      console.log(JSON.stringify({ user, profilePath }, null, 2));
    } else if (command === "sync") {
      console.log(
        JSON.stringify(
          await syncAgents({
            profilePath,
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
