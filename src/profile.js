import {
  mkdir,
  readFile,
  rename,
  rm,
  lstat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { BridgeError, PlatformClient } from "./client.js";

export const defaultProfile = join(
  homedir(),
  ".config",
  "cuijiao-bridge",
  "profile.json",
);

export async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readProfile(path, binding) {
  const stat = await lstat(path);
  if (!stat.isFile() || (process.platform !== "win32" && stat.mode & 0o077)) {
    throw new BridgeError(
      "凭证文件必须是普通文件且仅当前用户可读写（chmod 600）。",
    );
  }
  let profile;
  try {
    profile = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new BridgeError("凭证文件 JSON 无效。");
  }
  if (!Number.isSafeInteger(profile.userId) || profile.userId <= 0) {
    throw new BridgeError("凭证文件缺少绑定用户，请重新 configure。");
  }
  new PlatformClient(profile);
  if (
    binding &&
    (String(profile.userId) !== binding.userId ||
      profile.baseUrl !== binding.baseUrl)
  ) {
    throw new BridgeError(
      "凭证与已安装插件绑定的用户或平台不匹配，请重新同步。",
      "binding_mismatch",
    );
  }
  return profile;
}

export async function configure(path, baseUrl, token) {
  const client = new PlatformClient({ baseUrl, token });
  const user = await client.identity();
  try {
    const previous = await readProfile(path);
    if (previous.userId !== user.id || previous.baseUrl !== client.baseUrl) {
      throw new BridgeError(
        "此凭证文件已绑定其他账号或平台，请用 --profile 指定另一文件。",
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(
    path,
    JSON.stringify(
      { baseUrl: client.baseUrl, userId: user.id, token },
      null,
      2,
    ) + "\n",
  );
  return user;
}
