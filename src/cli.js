#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { configure, defaultProfile, readProfile } from "./profile.js";
import { BridgeError, PlatformClient } from "./client.js";
import { accountNamespace, syncAgents } from "./sync.js";
import { readToken } from "./token-input.js";

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
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      `萃角儿桥接插件\n\ninstall --url <平台 origin> --harness cc|codex|mcp [--token-stdin] [--profile <文件>]\n  按 Token 用户隔离连接并安装当前工具；mcp 生成配置与全部 Agent 技能，需当前工具继续接入。\nconfigure --url <平台 origin> [--profile <文件>] [--token-stdin]\n  隐藏输入 API Token，验证归属后保存为 600 权限的本机文件。\n  脚本可使用 --token-stdin 从管道输入。\nwhoami [--profile <文件>]\n  验证当前 Token 及绑定账号，不显示凭证。\nsync [--harness cc|codex|all] [--profile <文件>] [--dry-run | --generate-only]\n  同步全部平台 Agent 和默认平台助手；默认安装到两个 harness。\n  dry-run 只检查；generate-only 仅生成插件，供手动验收。`,
    );
  } else if (positionals.length !== 1) {
    throw new BridgeError("命令参数无效，请运行 --help。");
  } else {
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
    } else if (command === "whoami") {
      console.log(
        JSON.stringify(
          await new PlatformClient(await readProfile(profilePath)).identity(),
          null,
          2,
        ),
      );
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
  console.error(
    error instanceof BridgeError
      ? error.message
      : "操作失败，请检查参数、文件权限或 harness 配置（--help 查看用法）。",
  );
  process.exitCode = 1;
}
