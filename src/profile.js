import {
  mkdir,
  readFile,
  rename,
  rm,
  lstat,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { BridgeError, normalizeOrigin, PlatformClient } from "./client.js";

export const configDirectory = join(homedir(), ".cc");
export const profilesDirectory = join(configDirectory, "profiles");
export const defaultProfile = join(configDirectory, "profile.json");
export const legacyConfigDirectory = join(
  homedir(),
  ".config",
  "cuijiao-bridge",
);
const legacyDefaultProfile = join(legacyConfigDirectory, "profile.json");
export const cloudOrigin = "https://cc.agoodbit.com";
export const localOrigin = "http://localhost:8080";
const mobileCloudOrigin = "https://api.agoodbit.com";
export const activeConnectionPath = join(configDirectory, "active.json");
const legacyActiveConnectionPath = join(legacyConfigDirectory, "active.json");

export function accountNamespace(profile) {
  const originHash = createHash("sha256")
    .update(profile.baseUrl)
    .digest("hex")
    .slice(0, 12);
  return `cuijiao-${originHash}-u${profile.userId}`;
}

export function automaticProfilePath(baseUrl, userId) {
  return join(
    profilesDirectory,
    `${accountNamespace({ baseUrl: normalizeOrigin(baseUrl), userId })}.json`,
  );
}

function defaultCloudConnections(connections) {
  const web = connections.filter((entry) => entry.origin === cloudOrigin);
  return web.length
    ? web
    : connections.filter((entry) => entry.origin === mobileCloudOrigin);
}

export function describeConnection(baseUrl) {
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return {
    environment: local ? "local" : "cloud",
    name: `${local ? "本地" : "云端"} (${url.origin})`,
  };
}

function targetConnection(environment) {
  const origin = environment === "cloud" ? cloudOrigin : localOrigin;
  return { ...describeConnection(origin), origin, tokenConfigured: false };
}

function matchingConnections(connections, environment) {
  const candidates = connections.filter(
    (entry) => entry.environment === environment,
  );
  return environment === "cloud"
    ? defaultCloudConnections(candidates)
    : candidates;
}

export async function listConnections(extraProfilePath) {
  const paths = new Set([defaultProfile]);
  const legacyProfilesDirectory = join(legacyConfigDirectory, "profiles");
  for (const directory of [profilesDirectory, legacyProfilesDirectory]) {
    try {
      for (const name of (await readdir(directory)).sort()) {
        if (name.endsWith(".json")) paths.add(join(directory, name));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  paths.add(legacyDefaultProfile);
  if (extraProfilePath) paths.add(extraProfilePath);

  const connections = [];
  const issues = [];
  const newAccounts = new Set();
  for (const profilePath of paths) {
    let profile;
    try {
      profile = await readProfile(profilePath);
    } catch (error) {
      if (error.code === "ENOENT" && profilePath !== extraProfilePath) continue;
      issues.push({ profilePath, code: error.code || "invalid_profile" });
      continue;
    }
    const account = `${profile.baseUrl}:${profile.userId}`;
    const legacy =
      profilePath === legacyDefaultProfile ||
      dirname(profilePath) === legacyProfilesDirectory;
    if (legacy && newAccounts.has(account) && profilePath !== extraProfilePath)
      continue;
    if (
      profilePath === defaultProfile ||
      dirname(profilePath) === profilesDirectory
    )
      newAccounts.add(account);
    connections.push({
      ...describeConnection(profile.baseUrl),
      origin: profile.baseUrl,
      userId: profile.userId,
      profilePath,
    });
  }
  connections.sort((a, b) =>
    a.origin.localeCompare(b.origin) ||
    a.userId - b.userId ||
    a.profilePath.localeCompare(b.profilePath),
  );
  return { connections, issues };
}

async function readConnectionState(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || (process.platform !== "win32" && stat.mode & 0o077))
      throw new BridgeError("当前连接状态文件权限无效（需要 chmod 600）。");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("当前连接状态文件无效，请重新运行 connections use。");
  }
}

async function readActiveConnection() {
  let state = await readConnectionState(activeConnectionPath);
  if (state === undefined)
    state = await readConnectionState(legacyActiveConnectionPath);
  if (state === undefined) return null;
  const invalidState = () =>
    new BridgeError("当前连接状态文件无效，请重新运行 connections use。");
  if (!state || typeof state !== "object" || Array.isArray(state))
    throw invalidState();
  const hasBinding = ["profilePath", "origin", "userId"].some(
    (key) => state[key] !== undefined,
  );
  if (!hasBinding) {
    if (!["local", "cloud"].includes(state.environment)) throw invalidState();
    return { environment: state.environment };
  }
  if (
    typeof state.profilePath !== "string" ||
    !isAbsolute(state.profilePath) ||
    typeof state.origin !== "string" ||
    !Number.isSafeInteger(state.userId) ||
    state.userId <= 0
  )
    throw invalidState();
  let environment;
  try {
    if (normalizeOrigin(state.origin) !== state.origin) throw invalidState();
    environment = describeConnection(state.origin).environment;
  } catch {
    throw invalidState();
  }
  if (state.environment !== undefined && state.environment !== environment)
    throw invalidState();
  // Older state files stored only the profile binding, without an environment.
  return {
    environment,
    origin: state.origin,
    userId: state.userId,
    profilePath: state.profilePath,
  };
}

export async function currentConnection() {
  const active = await readActiveConnection();
  if (active?.profilePath) {
    const connection = {
      ...describeConnection(active.origin),
      origin: active.origin,
      userId: active.userId,
      profilePath: active.profilePath,
    };
    try {
      await readProfile(active.profilePath, {
        baseUrl: active.origin,
        userId: String(active.userId),
      });
      return { ...connection, tokenConfigured: true };
    } catch (error) {
      if (error.code === "ENOENT")
        return { ...connection, tokenConfigured: false };
      const credentialError =
        error instanceof BridgeError
          ? { code: error.code, message: error.message }
          : {
              code: "invalid_profile",
              message: "无法读取当前目标的凭证文件，请检查权限或重新配置。",
            };
      return { ...connection, tokenConfigured: false, credentialError };
    }
  }
  const environment = active?.environment ?? "cloud";
  const { connections } = await listConnections();
  const matches = matchingConnections(connections, environment);
  if (matches.length === 1) return { ...matches[0], tokenConfigured: true };
  return {
    ...targetConnection(environment),
    ...(matches.length > 1 ? { profileRequired: true } : {}),
  };
}

export async function requireCurrentConnection() {
  const connection = await currentConnection();
  if (connection.tokenConfigured) return connection;
  if (connection.credentialError)
    throw new BridgeError(
      connection.credentialError.message,
      connection.credentialError.code,
    );
  if (connection.profileRequired)
    throw new BridgeError(
      `当前目标存在多个账号连接，请运行 connections use ${connection.environment} --profile <文件> 指定。`,
      "connection_ambiguous",
    );
  throw new BridgeError(
    `当前目标为 ${connection.name}，尚未配置该目标的 Token；请运行 configure 配置。`,
    "token_not_configured",
  );
}

export async function useConnection(environment, extraProfilePath) {
  if (!["local", "cloud"].includes(environment))
    throw new BridgeError("请选择 local 或 cloud。", "invalid_arguments");
  let selected;
  if (extraProfilePath) {
    const profile = await readProfile(extraProfilePath);
    const description = describeConnection(profile.baseUrl);
    if (description.environment !== environment)
      throw new BridgeError(
        "连接文件的平台与所选 local/cloud 目标不匹配。",
        "invalid_arguments",
      );
    selected = {
      ...description,
      origin: profile.baseUrl,
      userId: profile.userId,
      profilePath: extraProfilePath,
      tokenConfigured: true,
    };
  } else {
    const { connections } = await listConnections();
    const matches = matchingConnections(connections, environment);
    selected =
      matches.length === 1
        ? { ...matches[0], tokenConfigured: true }
        : {
            ...targetConnection(environment),
            ...(matches.length > 1 ? { profileRequired: true } : {}),
          };
  }
  await atomicWrite(
    activeConnectionPath,
    JSON.stringify({
      environment,
      ...(selected.tokenConfigured
        ? {
            profilePath: selected.profilePath,
            origin: selected.origin,
            userId: selected.userId,
          }
        : {}),
    }) + "\n",
  );
  return { ...selected, agentSyncRequired: true };
}

export async function initializeProfiles() {
  const state = await readActiveConnection();
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(profilesDirectory, { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await writeFile(
      activeConnectionPath,
      JSON.stringify(state ?? { environment: "cloud" }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return {
    configDirectory,
    profilesDirectory,
    activeConnectionPath,
    created,
    connection: await currentConnection(),
  };
}

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

export async function configure(path, baseUrl, token, binding) {
  const client = new PlatformClient({ baseUrl, token });
  const user = await client.identity();
  if (binding?.userId !== undefined && binding.userId !== user.id)
    throw new BridgeError(
      "当前目标已选中其他账号，请用 --profile 保存另一账号的凭证，或通过 install 选择该账号。",
      "account_mismatch",
    );
  path ??= automaticProfilePath(client.baseUrl, user.id);
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
