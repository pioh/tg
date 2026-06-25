import "./_env.ts";
import { test, expect, afterAll } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setRpcTenant, getRpcTenant, hubCall } from "../src/lib/rpc.ts";
import { startHubServer } from "../src/hub.ts";
import { tenantDir } from "../src/lib/paths.ts";

// Изоляция от env-координат хаба (rpc сначала смотрит их) — в тестах их быть не должно.
delete process.env.TG_HUB_PORT;
delete process.env.TG_HUB_TOKEN;

const TOKEN = "ctx-test-token";
const PORT = 8794;
const server = startHubServer({ ping: async () => ({ pong: true }) }, TOKEN, PORT);
afterAll(() => server.stop(true));

test("без set_context → hubCall просит выбрать тенанта", async () => {
  expect(getRpcTenant()).toBeUndefined();
  await expect(hubCall("ping")).rejects.toThrow(/set_context/);
});

test("set_context без работающего сервиса → понятная ошибка про lock", async () => {
  await mkdir(tenantDir("nolock"), { recursive: true });
  setRpcTenant("nolock");
  expect(getRpcTenant()).toBe("nolock");
  await expect(hubCall("ping")).rejects.toThrow(/lock/i);
});

test("set_context + lock тенанта → hubCall идёт в его хаб", async () => {
  const dir = tenantDir("withhub");
  await mkdir(dir, { recursive: true });
  const lock = { pid: process.pid, port: PORT, token: TOKEN, startedAt: new Date().toISOString() };
  await writeFile(join(dir, "service.lock"), JSON.stringify(lock), "utf8");
  setRpcTenant("withhub");
  expect(await hubCall<{ pong: boolean }>("ping")).toEqual({ pong: true });
});

test("ECONNREFUSED на устаревшем порту → перечитывает lock и повторяет на живом", async () => {
  // lock сначала указывает на «мёртвый» порт (никто не слушает) → первый fetch падает с
  // connection refused; hubCall перечитывает lock. Хук перед самым повтором подменяет
  // lock на ЖИВОЙ порт хаба — повтор проходит. Имитирует «сервис перезапустился, сменил
  // порт». Подмена ровно между чтениями делается через afterFirstFetch ниже.
  const dir = tenantDir("moved");
  const lockFile = join(dir, "service.lock");
  await mkdir(dir, { recursive: true });
  const deadPort = 8779; // порт, на котором никто не слушает
  const writeLockFile = (port: number) =>
    writeFile(
      lockFile,
      JSON.stringify({ pid: process.pid, port, token: TOKEN, startedAt: new Date().toISOString() }),
      "utf8",
    );
  await writeLockFile(deadPort);
  setRpcTenant("moved");

  // Перехватываем fetch: первый вызов (на dead-порт) бросает «connection refused» и
  // переписывает lock на живой порт; дальше fetch работает как обычно (повтор → живой хаб).
  const realFetch = globalThis.fetch;
  let first = true;
  // @ts-expect-error — временная подмена глобального fetch для одного теста
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (first && String(input).includes(`:${deadPort}/`)) {
      first = false;
      await writeLockFile(PORT); // сервис «переехал» на живой порт
      const err = new Error("connect ECONNREFUSED") as Error & { code: string };
      err.code = "ECONNREFUSED";
      throw err;
    }
    return realFetch(input, init);
  };
  try {
    expect(await hubCall<{ pong: boolean }>("ping")).toEqual({ pong: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("401 на устаревшем токене → перечитывает lock и повторяет со свежим токеном", async () => {
  const dir = tenantDir("rotated");
  const lockFile = join(dir, "service.lock");
  await mkdir(dir, { recursive: true });
  const writeLockFile = (token: string) =>
    writeFile(
      lockFile,
      JSON.stringify({ pid: process.pid, port: PORT, token, startedAt: new Date().toISOString() }),
      "utf8",
    );
  // lock с НЕВЕРНЫМ токеном → хаб ответит 401.
  await writeLockFile("stale-token");
  setRpcTenant("rotated");
  // Перед повтором подменяем lock на правильный токен — повтор пройдёт авторизацию.
  const realFetch = globalThis.fetch;
  let first = true;
  // @ts-expect-error — временная подмена глобального fetch для одного теста
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input, init);
    if (first && res.status === 401) {
      first = false;
      await writeLockFile(TOKEN); // токен «ротировался»
    }
    return res;
  };
  try {
    expect(await hubCall<{ pong: boolean }>("ping")).toEqual({ pong: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});
