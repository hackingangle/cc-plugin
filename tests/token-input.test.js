import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { readToken } from "../src/token-input.js";

test("interactive token entry never echoes the pasted token and restores terminal mode", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const modes = [];
  input.setRawMode = (mode) => {
    modes.push(mode);
    input.isRaw = mode;
  };
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk;
      done();
    },
  });
  const pending = readToken({ input, output });
  const token = "hd_" + "a".repeat(43);
  input.write(token + "\r");
  assert.equal(await pending, token);
  assert.equal(text.includes(token), false);
  assert.deepEqual(modes, [true, false]);
});

test("cancelled terminal and oversized pipe input fail without saving a token", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const pending = readToken({ input, output });
  input.write("\x03");
  await assert.rejects(pending, /取消/);
  const piped = new PassThrough();
  piped.end("x".repeat(257));
  await assert.rejects(
    readToken({ fromStdin: true, input: piped, output }),
    /过长/,
  );
});
