import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configure } from "../src/profile.js";

export function cli(args, input, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/cli.js", import.meta.url)), ...args],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, error }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "cuijiao-bridge-"));
  const token = "hd_" + "a".repeat(43);
  const otherToken = "hd_" + "b".repeat(43);
  const state = {
    agents: [
      {
        id: 1,
        name: "采访助手",
        description: "采访、整理",
        system_prompt: "保留事实，记录引文。",
      },
    ],
    calls: [],
    revoked: false,
    failAgents: false,
  };
  const server = createServer(async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    state.calls.push({
      method: request.method,
      path: request.url,
      body: raw ? JSON.parse(raw) : undefined,
    });
    response.setHeader("Content-Type", "application/json");
    const credential = request.headers.authorization;
    if (
      state.revoked ||
      ![`Bearer ${token}`, `Bearer ${otherToken}`].includes(credential)
    ) {
      response
        .writeHead(401)
        .end(JSON.stringify({ error: "unauthorized", secret: token }));
    } else if (request.url === "/api/integrations/me") {
      response.end(
        JSON.stringify({
          id: credential.endsWith(token) ? 1 : 2,
          username: "alice",
          nickname: "采访者",
        }),
      );
    } else if (request.url === "/api/agents" && request.method === "GET") {
      if (state.failAgents) response.writeHead(503).end("{}");
      else response.end(JSON.stringify(state.agents));
    } else if (request.url === "/api/projects/999") {
      response.writeHead(404).end("{}");
    } else if (request.url === "/api/projects/301") {
      response.writeHead(302, { Location: `${baseUrl}/outside` }).end();
    } else if (request.method === "DELETE") response.writeHead(204).end();
    else response.end(JSON.stringify({ id: 7, ...state.calls.at(-1).body }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const profilePath = join(directory, "profile.json");
  await configure(profilePath, baseUrl, token);
  state.calls.length = 0;
  return { directory, profilePath, baseUrl, token, otherToken, state };
}
