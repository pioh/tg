import "./_env.ts";
import { test, expect } from "bun:test";
import { keepAccountOffline } from "../src/telegram/presence.ts";

// Фейковый mtcute-клиент: важна только воронка _client.call.
function fakeClient() {
  const calls: string[] = [];
  const client = {
    _client: {
      call: async (req: { _: string }) => {
        calls.push(req._);
        return {};
      },
    },
  };
  return { client, calls };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("после затишья шлём account.updateStatus(offline)", async () => {
  const { client, calls } = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(keepAccountOffline(client as any, 10)).toBe(true);

  await client._client.call({ _: "users.getUsers" });
  expect(calls).toEqual(["users.getUsers"]);

  await wait(40);
  expect(calls).toEqual(["users.getUsers", "account.updateStatus"]);
});

test("сам updateStatus не перезаводит таймер (нет бесконечного цикла)", async () => {
  const { client, calls } = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keepAccountOffline(client as any, 10);

  await client._client.call({ _: "messages.getHistory" });
  await wait(40);
  const afterFirst = calls.length;
  await wait(40);
  expect(calls.length).toBe(afterFirst); // тишина — новых запросов нет
  expect(calls.filter((c) => c === "account.updateStatus").length).toBe(1);
});

test("пачка запросов гасится ОДНИМ offline после последнего", async () => {
  const { client, calls } = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keepAccountOffline(client as any, 20);

  for (let i = 0; i < 5; i++) {
    await client._client.call({ _: "messages.getHistory" });
    await wait(5);
  }
  await wait(60);
  expect(calls.filter((c) => c === "account.updateStatus").length).toBe(1);
});

test("TG_KEEP_OFFLINE=0 выключает перехват", async () => {
  const prev = process.env.TG_KEEP_OFFLINE;
  process.env.TG_KEEP_OFFLINE = "0";
  try {
    const { client, calls } = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(keepAccountOffline(client as any, 10)).toBe(false);
    await client._client.call({ _: "users.getUsers" });
    await wait(40);
    expect(calls).toEqual(["users.getUsers"]);
  } finally {
    if (prev === undefined) delete process.env.TG_KEEP_OFFLINE;
    else process.env.TG_KEEP_OFFLINE = prev;
  }
});

test("после (пере)подключения статус гасится по событию соединения", async () => {
  const calls: string[] = [];
  let cb: ((s: string) => void) | undefined;
  const client = {
    _client: {
      call: async (req: { _: string }) => {
        calls.push(req._);
        return {};
      },
      onConnectionState: { add: (fn: (s: string) => void) => void (cb = fn) },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keepAccountOffline(client as any, 10);
  expect(typeof cb).toBe("function");

  cb!("connected"); // как после реконнекта: своих call() не было
  await wait(600); // гашение после коннекта идёт с небольшой задержкой (AFTER_CONNECT_MS)
  expect(calls).toEqual(["account.updateStatus"]);
});

test("TG_OFFLINE_HEARTBEAT_SEC: периодически подтверждаем оффлайн без своих запросов", async () => {
  const prev = process.env.TG_OFFLINE_HEARTBEAT_SEC;
  process.env.TG_OFFLINE_HEARTBEAT_SEC = "0.02"; // 20мс
  try {
    const { client, calls } = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keepAccountOffline(client as any, 10);
    await wait(90);
    expect(calls.filter((c) => c === "account.updateStatus").length).toBeGreaterThan(1);
  } finally {
    if (prev === undefined) delete process.env.TG_OFFLINE_HEARTBEAT_SEC;
    else process.env.TG_OFFLINE_HEARTBEAT_SEC = prev;
  }
});
