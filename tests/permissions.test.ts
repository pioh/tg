import "./_env.ts";
import { test, expect } from "bun:test";
import { grantPermission, revokePermission, revokeBySource, isAllowed, listPermissions } from "../src/lib/permissions.ts";

test("grant → isAllowed → revoke", async () => {
  expect(await isAllowed(777)).toBe(false);
  await grantPermission(777, { label: "тест", source: "test" });
  expect(await isAllowed(777)).toBe(true);
  const list = await listPermissions();
  expect(list["777"]?.mode).toBe("reply");
  expect(list["777"]?.label).toBe("тест");
  expect(await revokePermission(777)).toBe(true);
  expect(await isAllowed(777)).toBe(false);
  expect(await revokePermission(777)).toBe(false); // повторно — уже нет
});

test("revokeBySource снимает гранты конкретного монитора, не трогая ручные", async () => {
  await grantPermission(100, { source: "monitor:m1" });
  await grantPermission(101, { source: "monitor:m1" });
  await grantPermission(200, { source: "bot:/grant" }); // ручной — не трогаем
  expect(await isAllowed(100)).toBe(true);

  const n = await revokeBySource("monitor:m1");
  expect(n).toBe(2);
  expect(await isAllowed(100)).toBe(false);
  expect(await isAllowed(101)).toBe(false);
  expect(await isAllowed(200)).toBe(true); // ручной грант остался

  expect(await revokeBySource("monitor:m1")).toBe(0); // повторно — нечего снимать
});
