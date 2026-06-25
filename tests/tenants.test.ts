import "./_env.ts";
import { test, expect } from "bun:test";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createTenant, listTenants, tenantExists, withTenant, tenantContext, legacyDataDir, migrateLegacy, isTenantName, assertTenantName } from "../src/lib/tenants.ts";
import { REPO_ROOT, dataDir, tenantDir } from "../src/lib/paths.ts";
import { setMemory, getMemory } from "../src/lib/memory.ts";
import { TEST_DATA_DIR } from "./_env.ts";

test("тенанты изолированы: своя папка и память у каждого", async () => {
  // ВАЖНО: TG_TENANTS_DIR (из _env.ts) общий на весь прогон `bun test`, и другие тест-файлы
  // могут создать там своих тенантов раньше. Поэтому проверяем не глобальную пустоту
  // реестра, а изоляцию ИМЕННО созданных здесь тенантов (subset), и отсутствие чужого carol.
  await createTenant("alice");
  await createTenant("bob");
  const names = await listTenants();
  expect(names).toContain("alice");
  expect(names).toContain("bob");
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

test("legacyDataDir игнорирует TG_DATA_DIR — берёт только явный REPO_ROOT/data", () => {
  // _env.ts выставляет TG_DATA_DIR во временную папку тенанта. Раньше legacyDataDir()
  // читал его как источник миграции — скрытый env-фолбэк: с выставленным TG_DATA_DIR
  // migrateLegacy() переносил бы НЕ старую data/, а папку самого тенанта. Источник должен
  // быть только явным REPO_ROOT/data (а в тестах — отдельный TG_LEGACY_DATA_DIR).
  expect(process.env.TG_DATA_DIR).toBeTruthy();
  const prevLegacy = process.env.TG_LEGACY_DATA_DIR;
  delete process.env.TG_LEGACY_DATA_DIR;
  try {
    expect(legacyDataDir()).toBe(join(REPO_ROOT, "data"));
    expect(legacyDataDir()).not.toBe(process.env.TG_DATA_DIR);
  } finally {
    if (prevLegacy !== undefined) process.env.TG_LEGACY_DATA_DIR = prevLegacy;
  }
});

test("migrateLegacy переносит ЯВНЫЙ источник, а не env-папку тенанта", async () => {
  // Источник миграции задаём явным TG_LEGACY_DATA_DIR (НЕ TG_DATA_DIR), чтобы тест не
  // трогал реальную REPO_ROOT/data. Проверяем, что переносится именно эта папка.
  const src = join(TEST_DATA_DIR, "legacy-src");
  await mkdir(join(src, "session"), { recursive: true });
  await writeFile(join(src, "session", "account"), "x", "utf8");

  const prevLegacy = process.env.TG_LEGACY_DATA_DIR;
  process.env.TG_LEGACY_DATA_DIR = src;
  try {
    const dest = await migrateLegacy("migrated");
    expect(dest).toBe(tenantDir("migrated"));
    // Папка-источник переехала в tenants/<name>; контент сохранился.
    expect((await stat(join(dest, "session", "account"))).isFile()).toBe(true);
    await expect(stat(src)).rejects.toThrow(); // источник больше не существует (rename)
  } finally {
    if (prevLegacy === undefined) delete process.env.TG_LEGACY_DATA_DIR;
    else process.env.TG_LEGACY_DATA_DIR = prevLegacy;
  }
});

test("имя тенанта: traversal/слэши/точки отвергаются (нет скрытого фолбэка на data/)", async () => {
  for (const bad of ["../data", "..", "a/b", "a\\b", "a.b", "", "foo bar", "."]) {
    expect(isTenantName(bad)).toBe(false);
    expect(() => assertTenantName(bad)).toThrow();
  }
  for (const good of ["mayak", "main", "gena", "work_2", "a-b"]) expect(isTenantName(good)).toBe(true);
  // кривое имя не должно «существовать», строить путь или контекст (уход из tenants/)
  expect(await tenantExists("../data")).toBe(false);
  expect(() => tenantDir("../data")).toThrow();
  expect(() => tenantContext("../data", 0)).toThrow();
  // listTenants не возвращает папки с кривыми именами (не роняют старт сервиса)
  await mkdir(join(process.env.TG_TENANTS_DIR as string, "bad.name"), { recursive: true });
  expect(await listTenants()).not.toContain("bad.name");
});
