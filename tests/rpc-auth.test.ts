import "./_env.ts";
import { test, expect, afterAll } from "bun:test";
import { startHubServer } from "../src/hub.ts";

const TOKEN = "secret-test-token";
const PORT = 8793;
const server = startHubServer({ ping: async () => ({ pong: true }) }, TOKEN, PORT);
afterAll(() => server.stop(true));

const rpc = (headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ op: "ping" }),
  });

test("без токена → 401", async () => {
  expect((await rpc({})).status).toBe(401);
});

test("неверный токен → 401", async () => {
  expect((await rpc({ authorization: "Bearer nope" })).status).toBe(401);
});

test("верный токен → результат", async () => {
  const res = await rpc({ authorization: `Bearer ${TOKEN}` });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { result?: { pong: boolean } };
  expect(data.result?.pong).toBe(true);
});

test("/health доступен без токена", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  expect(res.ok).toBe(true);
});
