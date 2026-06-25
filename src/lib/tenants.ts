// Реестр тенантов. Один сервис обслуживает несколько независимых пользователей —
// у каждого своя рабочая папка в TENANTS_DIR (tenants/<имя>) со своей сессией Telegram,
// ботом, памятью, правилами и т.д. Здесь — перечисление/создание тенантов, запуск кода
// в контексте тенанта (через AsyncLocalStorage), и миграция legacy-папки data/.

import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { REPO_ROOT, TENANTS_DIR, tenantDir, tenantStore, isTenantName, assertTenantName, type TenantContext } from "./paths.ts";
import { ensureDataLayout } from "./memory.ts";

// Единый источник валидации имени тенанта — в paths.ts (там же tenantDir его применяет).
// Ре-экспортируем для удобных импортов из этого модуля.
export { isTenantName, assertTenantName };

// Базовый порт RPC-хаба; тенантам выдаются base, base+1, … (фактический порт пишется
// в lock каждого тенанта — MCP-прокси читает его оттуда).
export const HUB_BASE_PORT: number = Number(process.env.TG_HUB_PORT ?? 8765);

// Старая единая папка data/ — ТОЛЬКО как источник для одноразовой миграции в tenants/.
// В рантайме никакого legacy-режима нет (всё работает на тенантах).
//
// ВАЖНО: источник миграции — ЯВНЫЙ REPO_ROOT/data, и НИКОГДА не берётся из TG_DATA_DIR.
// TG_DATA_DIR указывает на рабочую папку ТЕКУЩЕГО тенанта (paths.dataDir), и если бы
// миграция читала источник оттуда, то при выставленном TG_DATA_DIR (а его ставит live-MCP
// и мастер setup) она бы перенесла НЕ старую data/, а папку самого тенанта — скрытый
// env-фолбэк и потенциальная потеря данных. Поэтому здесь TG_DATA_DIR игнорируется.
// Тестовый override источника — отдельный явный TG_LEGACY_DATA_DIR (чтобы тесты не трогали
// реальную REPO_ROOT/data); он НЕ участвует в выборе тенанта.
export function legacyDataDir(): string {
  return process.env.TG_LEGACY_DATA_DIR ? resolve(process.env.TG_LEGACY_DATA_DIR) : resolve(REPO_ROOT, "data");
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Имена всех тенантов (валидные папки в TENANTS_DIR), по алфавиту. Папки с кривым/
 *  traversal-именем игнорируются (а не роняют старт сервиса через tenantContext). */
export async function listTenants(): Promise<string[]> {
  try {
    const entries = await readdir(TENANTS_DIR, { withFileTypes: true });
    const names: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (!isTenantName(e.name)) continue; // пропускаем невалидные имена папок
      names.push(e.name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

export async function tenantExists(name: string): Promise<boolean> {
  if (!isTenantName(name)) return false; // кривое имя (traversal) = «не существует»
  return isDir(tenantDir(name));
}

/** Контекст тенанта (имя + папка + порт хаба). index определяет порт base+index. */
export function tenantContext(name: string, index: number): TenantContext {
  assertTenantName(name);
  return { name, dataDir: tenantDir(name), hubPort: HUB_BASE_PORT + index };
}

/** Выполнить fn в контексте тенанта: все path-функции укажут на его папку. */
export function withTenant<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStore.run(ctx, fn);
}

/** Создаёт папку тенанта и засевает структуру (data layout). */
export async function createTenant(name: string): Promise<string> {
  assertTenantName(name);
  const dir = tenantDir(name);
  if (await isDir(dir)) throw new Error(`Тенант "${name}" уже существует: ${dir}`);
  await mkdir(dir, { recursive: true });
  await withTenant({ name, dataDir: dir, hubPort: HUB_BASE_PORT }, () => ensureDataLayout());
  return dir;
}

/** Переносит legacy-папку data/ в tenants/<name> (единообразный формат). */
export async function migrateLegacy(name: string): Promise<string> {
  assertTenantName(name);
  const src = legacyDataDir();
  const dest = tenantDir(name);
  if (!(await isDir(src))) throw new Error(`Папка ${src} не найдена — мигрировать нечего.`);
  if (await isDir(dest)) throw new Error(`Тенант "${name}" уже существует: ${dest}`);
  await mkdir(TENANTS_DIR, { recursive: true });
  await rename(src, dest);
  return dest;
}

const AUTO_MIGRATE_NAME = "main"; // имя тенанта для автоматической миграции старой data/

/** Автоматическая одноразовая миграция: если тенантов нет, но есть старая папка data/
 *  (апгрейд со старой версии) — переносим её в tenants/main. Возвращает путь или null.
 *  Зовётся на старте сервиса и в doctor, чтобы апгрейд проходил без ручных шагов. */
export async function autoMigrateLegacy(): Promise<string | null> {
  if ((await listTenants()).length > 0) return null; // уже на тенантах
  const src = legacyDataDir();
  if (!(await isDir(src))) return null; // папки нет
  // Мигрируем только РЕАЛЬНУЮ старую установку (есть сессия или конфиг), а не пустой
  // placeholder data/.gitkeep на свежем клоне.
  const real = (await Bun.file(join(src, "session", "account")).exists()) || (await Bun.file(join(src, "config.json")).exists());
  if (!real) return null;
  return migrateLegacy(AUTO_MIGRATE_NAME);
}
