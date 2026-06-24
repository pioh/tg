import "./_env.ts";
import { test, expect } from "bun:test";
import { createTenant, listTenants, tenantExists, withTenant, tenantContext } from "../src/lib/tenants.ts";
import { dataDir } from "../src/lib/paths.ts";
import { setMemory, getMemory } from "../src/lib/memory.ts";

test("тенанты изолированы: своя папка и память у каждого", async () => {
  expect(await listTenants()).toEqual([]);

  await createTenant("alice");
  await createTenant("bob");
  expect((await listTenants()).sort()).toEqual(["alice", "bob"]);
  expect(await tenantExists("alice")).toBe(true);
  expect(await tenantExists("carol")).toBe(false);

  // dataDir() в контексте указывает на папку конкретного тенанта.
  const aDir = withTenant(tenantContext("alice", 0), () => dataDir());
  const bDir = withTenant(tenantContext("bob", 1), () => dataDir());
  expect(aDir).not.toBe(bDir);
  expect(aDir.endsWith("alice")).toBe(true);

  // Память не пересекается между тенантами.
  await withTenant(tenantContext("alice", 0), () => setMemory("note", "alice-secret"));
  expect(await withTenant(tenantContext("bob", 1), () => getMemory("note"))).toBeNull();
  expect(await withTenant(tenantContext("alice", 0), () => getMemory("note"))).toContain("alice-secret");

  // Порты хабов у разных тенантов разные (base + index).
  expect(tenantContext("alice", 0).hubPort).not.toBe(tenantContext("bob", 1).hubPort);
});

test("createTenant отвергает дубликат и кривое имя", async () => {
  await createTenant("dup");
  await expect(createTenant("dup")).rejects.toThrow();
  await expect(createTenant("bad name!")).rejects.toThrow();
});
