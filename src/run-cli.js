import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./client.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

export function runCli(command, input, { profilePath, userId, baseUrl, active }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (active) {
      delete env.CUIJIAO_USER_ID;
      delete env.CUIJIAO_ORIGIN;
    } else {
      env.CUIJIAO_USER_ID = String(userId);
      env.CUIJIAO_ORIGIN = baseUrl;
    }
    const child = execFile(
      process.execPath,
      [
        cliPath,
        ...command.split(" "),
        ...(active ? [] : ["--profile", profilePath]),
        "--input-stdin",
      ],
      {
        env,
        timeout: command === "asr transcribe" ? 375000 : 40000,
        // Preserve complete material snapshots and candidate text.
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
