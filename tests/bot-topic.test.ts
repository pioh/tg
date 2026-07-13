import "./_env.ts";
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { dataDir } from "../src/lib/paths.ts";
import { botSend, callBotApi } from "../src/lib/bot.ts";

const CFG = join(dataDir(), "config.json");
const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

async function withBotConfig(): Promise<void> {
  await Bun.write(CFG, JSON.stringify({ apiId: 1, apiHash: "x", botToken: "T", botOwnerChatId: 555 }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureFetch(calls: any[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
  }) as any;
}

test("botSend прокидывает message_thread_id в sendMessage (топик)", async () => {
  await withBotConfig();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: any[] = [];
  captureFetch(calls);
  await botSend("привет", 12345, 777);
  const send = calls.find((c) => c.url.endsWith("/sendMessage"));
  expect(send.body.chat_id).toBe(12345);
  expect(send.body.message_thread_id).toBe(777);
});

test("botSend без threadId НЕ добавляет message_thread_id", async () => {
  await withBotConfig();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: any[] = [];
  captureFetch(calls);
  await botSend("привет", 12345);
  const send = calls.find((c) => c.url.endsWith("/sendMessage"));
  expect("message_thread_id" in send.body).toBe(false);
});

test("callBotApi зовёт произвольный метод Bot API с params", async () => {
  await withBotConfig();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, result: { id: 42 } }), { headers: { "content-type": "application/json" } });
  }) as any;
  const res = await callBotApi("sendPoll", { chat_id: 5, question: "q", options: ["a", "b"] });
  expect(captured.url.endsWith("/botT/sendPoll")).toBe(true);
  expect(captured.body.question).toBe("q");
  expect(res).toEqual({ id: 42 });
});
