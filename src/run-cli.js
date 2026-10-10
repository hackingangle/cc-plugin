import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./client.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

export function runCli(command, input, { profilePath, userId, baseUrl }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        cliPath,
        ...command.split(" "),
        "--profile",
        profilePath,
        "--input-stdin",
      ],
      {
        env: {
          ...process.env,
          CUIJIAO_USER_ID: String(userId),
          CUIJIAO_ORIGIN: baseUrl,
        },
        timeout: 40000,
        // Preserve full material responses; the platform owns content-size limits.
        maxBuffer: Infinity,
      },
      (error, stdout, stderr) => {
        // Never surface raw child-process diagnostics or credential-bearing arguments.
        if (error) {
          let failure;
          try {
            failure = JSON.parse(stderr).error;
          } catch {}
          reject(
            new BridgeError(
              typeof failure?.message === "string"
                ? failure.message
                : "CLI 未正常完成；写入结果可能未知，请先查询，勿自动重试。",
              typeof failure?.code === "string" ? failure.code : "cli_failed",
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new BridgeError(
              "CLI 未返回有效 JSON；写入结果请先查询确认。",
              "invalid_response",
            ),
          );
        }
      },
    );
    // A child that rejects its arguments can exit before consuming stdin.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
