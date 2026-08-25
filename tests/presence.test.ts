import "./_env.ts";
import { test, expect } from "bun:test";
import { isWriteMethod, keepAccountOffline } from "../src/telegram/presence.ts";

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

test("после ДЕЙСТВИЯ (отправки) шлём account.updateStatus(offline)", async () => {
  const { client, calls } = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(keepAccountOffline(client as any, 10)).toBe(true);

  await client._client.call({ _: "messages.sendMessage" });
  expect(calls).toEqual(["messages.sendMessage"]);

  await wait(40);
  expect(calls).toEqual(["messages.sendMessage", "account.updateStatus"]);
});

test("ЧТЕНИЕ статус не трогает — гасить после него не надо", async () => {
  const { client, calls } = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keepAccountOffline(client as any, 10);

  await client._client.call({ _: "messages.getHistory" });
  await client._client.call({ _: "messages.getDialogs" });
  await client._client.call({ _: "users.getUsers" });
  await wait(60);
  expect(calls.filter((c) => c === "account.updateStatus").length).toBe(0);
});

test("сам updateStatus не перезаводит таймер (нет бесконечного цикла)", async () => {
  const { client, calls } = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keepAccountOffline(client as any, 10);

  await client._client.call({ _: "messages.sendMessage" });
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
    await client._client.call({ _: "messages.sendMessage" });
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
    await client._client.call({ _: "messages.sendMessage" });
    await wait(40);
    expect(calls).toEqual(["messages.sendMessage"]);
  } finally {
    if (prev === undefined) delete process.env.TG_KEEP_OFFLINE;
    else process.env.TG_KEEP_OFFLINE = prev;
  }
});

test("isWriteMethod: действия отличаются от чтения", () => {
  for (const m of ["messages.sendMessage", "messages.editMessage", "messages.deleteMessages", "messages.readHistory", "messages.setTyping"]) {
    expect(isWriteMethod(m)).toBe(true);
  }
  for (const m of ["messages.getHistory", "messages.getDialogs", "users.getUsers", "updates.getState", "contacts.resolveUsername", undefined]) {
    expect(isWriteMethod(m as string)).toBe(false);
  }
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
