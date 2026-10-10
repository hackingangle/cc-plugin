import { z } from "zod";

export class BridgeError extends Error {
  constructor(message, code = "bridge_error") {
    super(message);
    this.code = code;
  }
}

export function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BridgeError("平台地址无效。");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new BridgeError(
      "平台地址须为 HTTPS origin；本地调试允许 loopback HTTP，不能带路径、凭证或查询参数。",
    );
  }
  return url.origin;
}

export const userSchema = z.object({
  id: z.number().int().positive().safe(),
  username: z.string(),
  nickname: z.string(),
});
export const agentsSchema = z
  .array(
    z.object({
      id: z.number().int().positive().safe(),
      name: z.string().min(1),
      description: z.string().nullable(),
      system_prompt: z.string().min(1),
    }),
  )
  .refine(
    (agents) => new Set(agents.map((agent) => agent.id)).size === agents.length,
  );

export class PlatformClient {
  constructor({ baseUrl, token, userId }) {
    this.baseUrl = normalizeOrigin(baseUrl);
    if (!/^hd_[A-Za-z0-9_-]{43}$/.test(token ?? "")) {
      throw new BridgeError(
        "请使用平台设置中创建的 API Token，不能使用登录会话。",
      );
    }
    this.token = token;
    this.userId = userId;
  }

  async request(method, path, body) {
    // Only code-defined API routes may carry the credential. Never follow redirects.
    if (!/^\/api\/[a-z0-9/?_=&-]+$/.test(path))
      throw new BridgeError("无效的平台接口路径。");
    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new BridgeError(
        "平台请求失败或超时；写入结果可能未知，请先查询，勿自动重试写入。",
        "request_failed",
      );
    }
    if (!response.ok) {
      const messages = {
        401: "Token 无效或已撤销，请在平台重新创建并配置。",
        403: "当前 Token 没有此操作权限。",
        404: "资源不存在或不属于当前 Token 的用户；请同时确认后端已升级。",
        409: "资源冲突，请刷新后重试。",
        429: "请求过于频繁，请稍后重试。",
      };
      // Do not return arbitrary upstream error bodies, which may contain secrets.
      await response.body?.cancel();
      throw new BridgeError(
        messages[response.status] ??
          `平台返回 HTTP ${response.status}，请检查输入或服务状态。`,
        `http_${response.status}`,
      );
    }
    if (response.status === 204) return { deleted: true };
    try {
      return await response.json();
    } catch {
      throw new BridgeError(
        "平台未返回有效 JSON；写入结果请先查询确认。",
        "invalid_response",
      );
    }
  }

  async identity() {
    const parsed = userSchema.safeParse(
      await this.request("GET", "/api/integrations/me"),
    );
    if (!parsed.success) throw new BridgeError("平台用户响应格式不兼容。");
    if (this.userId !== undefined && this.userId !== parsed.data.id) {
      throw new BridgeError(
        "Token 所属用户与插件绑定用户不同，请为该用户单独配置并同步。",
        "account_mismatch",
      );
    }
    return parsed.data;
  }

  async agents() {
    const parsed = agentsSchema.safeParse(
      await this.request("GET", "/api/agents"),
    );
    if (!parsed.success)
      throw new BridgeError("Agent 列表格式不兼容；保留上次同步结果。");
    return parsed.data.sort((a, b) => a.id - b.id);
  }
}
