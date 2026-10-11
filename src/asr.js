import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { BridgeError } from "./client.js";

const bytesPerSecond = 16000 * 2;
// shortcut: 文件转写最多 5 分钟；需要长录音时改为流式读文件并调整 CLI 超时。
const maxAudioBytes = bytesPerSecond * 300;
const chunkBytes = 6400;

export async function transcribeAudio({ audio_path }, client, ticketPath) {
  let file;
  let audio;
  try {
    file = await open(audio_path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size === 0 ||
      info.size % 2 !== 0 ||
      info.size > maxAudioBytes
    )
      throw new BridgeError(
        "音频须为非空 16kHz 单声道 pcm_s16le 普通文件，字节数为偶数且时长不超过 5 分钟。",
        "invalid_arguments",
      );
    audio = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < audio.length) {
      const { bytesRead } = await file.read(
        audio,
        offset,
        audio.length - offset,
        offset,
      );
      if (!bytesRead)
        throw new BridgeError(
          "音频文件在读取时发生变化。",
          "invalid_arguments",
        );
      offset += bytesRead;
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("无法读取音频文件。", "invalid_arguments");
  } finally {
    await file?.close();
  }

  const ticket = await client.request("POST", ticketPath);
  if (
    typeof ticket?.ticket !== "string" ||
    !/^[a-f0-9]{64}$/.test(ticket?.ticket ?? "") ||
    typeof ticket.expires_at !== "string" ||
    !Number.isFinite(Date.parse(ticket.expires_at)) ||
    Date.parse(ticket.expires_at) <= Date.now()
  )
    throw new BridgeError("ASR 连接凭据格式无效或已过期。", "invalid_response");
  const url = new URL("/api/asr/ws", client.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket.ticket);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let timer;
    let audioTimer;
    let offset = 0;
    let connected = false;
    let ready = false;
    let finishedInput = false;
    let settled = false;
    const segments = new Map();
    const revisions = new Map();
    const complete = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(audioTimer);
      socket.close();
      if (error) reject(error);
      else {
        const finals = [...revisions.keys()]
          .map((id) => segments.get(id))
          .filter(Boolean);
        resolve({
          text: finals.map((segment) => segment.text).join(""),
          segments: finals,
        });
      }
    };
    const timeout = (milliseconds) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => complete(new BridgeError("ASR 识别超时。", "asr_timeout")),
        milliseconds,
      );
    };
    const sendAudio = () => {
      if (settled) return;
      if (offset === audio.length) {
        finishedInput = true;
        socket.send(JSON.stringify({ type: "finish" }));
        timeout(15000);
        return;
      }
      const end = Math.min(offset + chunkBytes, audio.length);
      socket.send(audio.subarray(offset, end));
      const sentBytes = end - offset;
      offset = end;
      audioTimer = setTimeout(sendAudio, (sentBytes / bytesPerSecond) * 1000);
    };
    timeout(15000);
    socket.addEventListener("message", ({ data }) => {
      if (settled) return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        complete(new BridgeError("ASR 返回无效 JSON。", "invalid_response"));
        return;
      }
      if (!event || typeof event !== "object") {
        complete(new BridgeError("ASR 返回无效消息。", "invalid_response"));
      } else if (event.type === "error") {
        complete(
          new BridgeError(
            "ASR 服务不可用或拒绝了音频，请检查服务状态。",
            "asr_failed",
          ),
        );
      } else if (event.type === "connected" && !connected) {
        connected = true;
        socket.send(
          JSON.stringify({
            mode: "2pass",
            format: "pcm_s16le",
            sample_rate: 16000,
          }),
        );
      } else if (event.type === "ready" && connected && !ready) {
        ready = true;
        timeout((audio.length / bytesPerSecond) * 1000 + 15000);
        sendAudio();
      } else if (event.type === "finished" && finishedInput) {
        complete();
      } else if (
        (event.status === "partial" || event.status === "final") &&
        ready
      ) {
        if (
          typeof event.segment_id !== "string" ||
          event.segment_id.length === 0 ||
          !Number.isSafeInteger(event.revision) ||
          event.revision < 0 ||
          typeof event.text !== "string"
        ) {
          complete(
            new BridgeError("ASR 识别结果格式无效。", "invalid_response"),
          );
          return;
        }
        if (event.revision <= (revisions.get(event.segment_id) ?? -1)) return;
        revisions.set(event.segment_id, event.revision);
        if (event.status === "final")
          segments.set(event.segment_id, {
            segment_id: event.segment_id,
            revision: event.revision,
            text: event.text,
          });
      }
    });
    socket.addEventListener("error", () =>
      complete(new BridgeError("ASR 连接失败。", "request_failed")),
    );
    socket.addEventListener("close", () =>
      complete(
        new BridgeError("ASR 在识别完成前断开连接。", "asr_disconnected"),
      ),
    );
  });
}
