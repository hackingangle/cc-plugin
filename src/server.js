import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readProfile } from "./profile.js";
import { BridgeError } from "./client.js";
import { createServer } from "./tools.js";

try {
  if (process.env.CUIJIAO_CONNECTION_MODE === "active") {
    await serveStdio(() => createServer({ active: true }));
  } else {
    const profilePath = process.env.CUIJIAO_PROFILE;
    const profile = await readProfile(profilePath, {
      userId: process.env.CUIJIAO_USER_ID,
      baseUrl: process.env.CUIJIAO_ORIGIN,
    });
    await serveStdio(() =>
      createServer({
        profilePath,
        userId: profile.userId,
        baseUrl: profile.baseUrl,
      }),
    );
  }
} catch (error) {
  console.error(
    error instanceof BridgeError
      ? error.message
      : "无法启动平台工具，请检查凭证文件和安装路径。",
  );
  process.exitCode = 1;
}
