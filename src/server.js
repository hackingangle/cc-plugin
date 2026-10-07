import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readProfile } from "./profile.js";
import { BridgeError, PlatformClient } from "./client.js";
import { createServer } from "./tools.js";

try {
  const profile = await readProfile(process.env.CUIJIAO_PROFILE);
  if (
    String(profile.userId) !== process.env.CUIJIAO_USER_ID ||
    profile.baseUrl !== process.env.CUIJIAO_ORIGIN
  ) {
    throw new BridgeError(
      "凭证与已安装插件绑定的用户或平台不匹配，请重新同步。",
    );
  }
  const client = new PlatformClient(profile);
  await serveStdio(() => createServer(client));
} catch (error) {
  console.error(
    error instanceof BridgeError
      ? error.message
      : "无法启动平台工具，请检查凭证文件和安装路径。",
  );
  process.exitCode = 1;
}
