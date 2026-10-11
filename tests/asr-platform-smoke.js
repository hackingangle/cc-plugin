// Run against an isolated real Go backend in ASR mock mode, never a paid provider.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { cli } from "./helpers.js";
import { platformFixture } from "./platform-helpers.js";

test("standalone CLI authenticates ASR, sends PCM and receives flushed final text", async (t) => {
  const { origin, directory, password, sessions, api } =
    await platformFixture(t);
  const session = await api(
    "POST",
    "/api/auth/register",
    undefined,
    {
      username: `asr_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      password,
    },
    201,
  );
  sessions.push(session);
  const token = await api(
    "POST",
    "/api/tokens",
    session.token,
    { name: "CLI ASR test" },
    201,
  );
  const profile = join(directory, "profile.json");
  const env = { PATH: directory };
  const configured = await cli(
    ["configure", "--url", origin, "--profile", profile, "--token-stdin"],
    token.token,
    env,
  );
  assert.equal(configured.code, 0, configured.error);
  const invoke = (command, input = {}) =>
    cli(
      [...command.split(" "), "--profile", profile, "--input-stdin"],
      JSON.stringify(input),
      env,
    );
  const health = await invoke("asr health");
  assert.equal(health.code, 0, health.error);
  assert.equal(
    JSON.parse(health.output).mode,
    "mock",
    "ASR smoke requires mock mode to avoid cloud billing",
  );
  const audioPath = join(directory, "audio.pcm");
  await writeFile(audioPath, Buffer.alloc(12800));
  const result = await invoke("asr transcribe", { audio_path: audioPath });
  assert.equal(result.code, 0, result.error);
  const transcript = JSON.parse(result.output);
  assert.ok(transcript.text.length > 0);
  assert.equal(
    transcript.text,
    transcript.segments.map((segment) => segment.text).join(""),
  );
  assert.ok(transcript.segments.every((segment) => segment.revision >= 2));
  assert.equal((result.output + result.error).includes(token.token), false);
  await t.test("stdio MCP reuses the ASR CLI command", async (t) => {
    const client = new Client({ name: "asr-smoke", version: "1.0.0" });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
        env: {
          ...env,
          CUIJIAO_PROFILE: profile,
          CUIJIAO_USER_ID: String(session.user.id),
          CUIJIAO_ORIGIN: origin,
        },
        stderr: "pipe",
      }),
    );
    const response = await client.callTool({
      name: "transcribe_audio",
      arguments: { audio_path: audioPath },
    });
    assert.notEqual(response.isError, true, response.content[0].text);
    assert.equal(JSON.parse(response.content[0].text).text, transcript.text);
    assert.equal(JSON.stringify(response).includes(token.token), false);
  });
  await api("DELETE", `/api/tokens/${token.id}`, session.token, undefined, 204);
  const revoked = await invoke("asr transcribe", { audio_path: audioPath });
  assert.equal(revoked.code, 1);
  assert.equal(JSON.parse(revoked.error).error.code, "http_401");
  assert.equal(revoked.output, "");
});
