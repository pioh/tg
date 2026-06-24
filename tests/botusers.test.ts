import "./_env.ts";
import { test, expect } from "bun:test";
import { listBotUsers, isBotUserAllowed, allowBotUser, denyBotUser } from "../src/lib/botusers.ts";

test("allowlist бота: по умолчанию пусто, allow/deny работают", async () => {
  expect(await listBotUsers()).toEqual([]);
  expect(await isBotUserAllowed(42)).toBe(false);

  const u = await allowBotUser(42, { username: "vasya", note: "коллега" });
  expect(u.id).toBe(42);
  expect(u.username).toBe("vasya");
  expect(await isBotUserAllowed(42)).toBe(true);

  // идемпотентно — повторный allow не плодит дубли, обновляет поля
  await allowBotUser(42, { note: "семья" });
  const list = await listBotUsers();
  expect(list.length).toBe(1);
  expect(list[0]?.note).toBe("семья");

  expect(await denyBotUser(42)).toBe(true);
  expect(await isBotUserAllowed(42)).toBe(false);
  expect(await denyBotUser(42)).toBe(false); // уже нет
});
