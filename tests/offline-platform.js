// A file-backed fake fetch shared by real CLI/MCP subprocesses; opens no sockets.
import { readFile, writeFile } from "node:fs/promises";

export const fakeOrigin = "http://127.0.0.1:1";
export const fakeToken = "hd_" + "a".repeat(43);

export function fakeFetch(statePath) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== fakeOrigin) throw new Error("Unexpected fake API origin");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ method, path: url.pathname + url.search, body });
    if (options.headers?.["Idempotency-Key"] !== undefined)
      throw new Error("Unexpected idempotency header");
    let status = 200;
    let result;
    if (state.revoked || options.headers?.Authorization !== `Bearer ${fakeToken}`) {
      status = 401;
      result = { error: "unauthorized" };
    } else if (url.pathname === "/api/integrations/me") {
      result = { id: 1, username: "fixture", nickname: "Fixture" };
    } else if (url.pathname === "/api/agents") {
      result = state.agents;
    } else if (url.pathname === "/api/projects") {
      result = [{ id: 7, title: "Fixture project" }];
    } else if (url.pathname === "/api/projects/7/materials") {
      if (method === "POST") {
        result = { id: state.nextId++, project_id: 7, ...body };
        state.materials.push(result);
        status = 201;
      } else {
        result = { items: state.materials, total: state.materials.length, page: 1, page_size: 100 };
      }
    } else if (/^\/api\/materials\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/").at(-1));
      result = state.materials.find((material) => material.id === id);
      if (!result) status = 404;
      else if (method === "PATCH") Object.assign(result, body);
      else if (method === "DELETE") {
        state.materials = state.materials.filter((material) => material.id !== id);
        status = 204;
      }
    } else status = 404;
    await writeFile(statePath, JSON.stringify(state));
    return new Response(status === 204 ? null : JSON.stringify(result ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

if (process.env.BRIDGE_TEST_STATE) {
  globalThis.fetch = fakeFetch(process.env.BRIDGE_TEST_STATE);
}
