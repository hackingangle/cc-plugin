import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeAudio } from "../src/asr.js";

test("ASR sends paced PCM only after ready, flushes final revisions and closes without exposing credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cuijiao-asr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audioPath = join(directory, "audio.pcm");
  const audio = Buffer.alloc(12800, 7);
  await writeFile(audioPath, audio);
  const ticket = "a".repeat(64);
  const client = {
    baseUrl: "https://platform.example",
    request: async (method, path) => {
      assert.equal(method, "POST");
      assert.equal(path, "/api/asr/tickets");
      return { ticket, expires_at: new Date(Date.now() + 30000).toISOString() };
    },
  };
  const calls = [];
  let socket;
  class Socket extends EventTarget {
    constructor(url) {
      super();
      socket = this;
      assert.equal(
        url.toString(),
        `wss://platform.example/api/asr/ws?ticket=${ticket}`,
      );
      queueMicrotask(() => this.emit({ type: "connected" }));
    }
    emit(message) {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(message) }),
      );
    }
    send(data) {
      calls.push(data);
      if (Buffer.isBuffer(data)) return;
      const message = JSON.parse(data);
      if (message.mode) {
        assert.deepEqual(message, {
          mode: "2pass",
          format: "pcm_s16le",
          sample_rate: 16000,
        });
        assert.equal(calls.length, 1);
        queueMicrotask(() => {
          this.emit({ type: "ready" });
          this.emit({ type: "ready" });
          this.emit({
            segment_id: "first",
            revision: 1,
            status: "partial",
            text: "草稿",
          });
          this.emit({
            segment_id: "second",
            revision: 1,
            status: "final",
            text: "世界",
          });
        });
      } else {
        assert.deepEqual(message, { type: "finish" });
        queueMicrotask(() => {
          this.emit({
            segment_id: "first",
            revision: 3,
            status: "final",
            text: "你好",
          });
          this.emit({
            segment_id: "first",
            revision: 2,
            status: "final",
            text: "过时",
          });
          this.emit({ type: "finished" });
        });
      }
    }
    close() {
      this.closed = true;
    }
  }
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });
  const result = await transcribeAudio(
    { audio_path: audioPath },
    client,
    "/api/asr/tickets",
  );
  assert.deepEqual(result, {
    text: "你好世界",
    segments: [
      { segment_id: "first", revision: 3, text: "你好" },
      { segment_id: "second", revision: 1, text: "世界" },
    ],
  });
  assert.deepEqual(Buffer.concat(calls.filter(Buffer.isBuffer)), audio);
  assert.equal(calls.filter(Buffer.isBuffer).length, 2);
  assert.equal(socket.closed, true);
  assert.equal(JSON.stringify(result).includes(ticket), false);
});

test("ASR rejects unreadable, empty, odd-length and oversized files before creating a ticket", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cuijiao-asr-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = {
    request: () => assert.fail("invalid files must not request a ticket"),
  };
  for (const size of [0, 3, 9600002]) {
    const audioPath = join(directory, `${size}.pcm`);
    await writeFile(audioPath, Buffer.alloc(size));
    await assert.rejects(transcribeAudio({ audio_path: audioPath }, client), {
      code: "invalid_arguments",
    });
  }
  for (const path of [directory, join(directory, "missing.pcm")])
    await assert.rejects(transcribeAudio({ audio_path: path }, client), {
      code: "invalid_arguments",
    });
});

test("ASR fails closed on malformed tickets, cloud failure, disconnect and handshake timeout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cuijiao-asr-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audioPath = join(directory, "audio.pcm");
  await writeFile(audioPath, Buffer.alloc(2));
  const client = {
    baseUrl: "http://127.0.0.1:8081",
    request: async () => ({
      ticket: "a".repeat(64),
      expires_at: new Date(Date.now() + 30000).toISOString(),
    }),
  };
  for (const ticket of [
    { ticket: "secret" },
    { ticket: "a".repeat(64), expires_at: "2000-01-01T00:00:00Z" },
  ])
    await assert.rejects(
      transcribeAudio(
        { audio_path: audioPath },
        { ...client, request: async () => ticket },
      ),
      { code: "invalid_response" },
    );

  for (const [name, code] of [
    ["cloud", "asr_failed"],
    ["close", "asr_disconnected"],
    ["malformed", "invalid_response"],
    ["timeout", "asr_timeout"],
  ]) {
    await t.test(name, async (t) => {
      let created;
      const opened = new Promise((resolve) => {
        created = resolve;
      });
      let socket;
      class Socket extends EventTarget {
        constructor() {
          super();
          socket = this;
          created();
          queueMicrotask(() => {
            if (name === "cloud")
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({ type: "error", message: "secret" }),
                }),
              );
            if (name === "close") this.dispatchEvent(new Event("close"));
            if (name === "malformed")
              this.dispatchEvent(new MessageEvent("message", { data: "{" }));
          });
        }
        close() {
          this.closed = true;
        }
      }
      const originalWebSocket = globalThis.WebSocket;
      globalThis.WebSocket = Socket;
      t.after(() => {
        globalThis.WebSocket = originalWebSocket;
      });
      if (name === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
      const failure = assert.rejects(
        transcribeAudio({ audio_path: audioPath }, client),
        (error) => {
          assert.equal(error.code, code);
          assert.equal(error.message.includes("secret"), false);
          return true;
        },
      );
      await opened;
      if (name === "timeout") t.mock.timers.tick(15000);
      await failure;
      assert.equal(socket.closed, true);
    });
  }
});
