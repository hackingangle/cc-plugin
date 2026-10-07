import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { BridgeError } from "./client.js";

export async function readToken({
  fromStdin = false,
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (fromStdin) {
    if (input.isTTY)
      throw new BridgeError(
        "--token-stdin 需要管道输入；交互配置请省略此参数。",
      );
    let token = "";
    for await (const chunk of input) {
      token += chunk;
      if (token.length > 256) throw new BridgeError("Token 输入过长。");
    }
    return token.trim();
  }
  if (!input.isTTY)
    throw new BridgeError(
      "请在电脑终端交互配置，或使用 --token-stdin 从管道读取。",
    );
  output.write("平台 API Token（粘贴后按回车，输入不会显示）: ");
  // readline handles editing and terminal mode; its echo output is discarded.
  const hiddenOutput = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({
    input,
    output: hiddenOutput,
    terminal: true,
  });
  try {
    return await new Promise((resolve, reject) => {
      reader.once("close", () => reject(new BridgeError("已取消配置。")));
      reader.once("SIGINT", () => reader.close());
      reader.question("", (token) => resolve(token.trim()));
    });
  } finally {
    reader.close();
    hiddenOutput.end();
    output.write("\n");
  }
}
