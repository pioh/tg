import "./_env.ts";
import { test, expect } from "bun:test";
import { grantPermission, revokePermission, isAllowed, listPermissions } from "../src/lib/permissions.ts";

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
