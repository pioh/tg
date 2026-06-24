// Реестр тенантов. Один сервис обслуживает несколько независимых пользователей —
// у каждого своя рабочая папка в TENANTS_DIR (tenants/<имя>) со своей сессией Telegram,
// ботом, памятью, правилами и т.д. Здесь — перечисление/создание тенантов, запуск кода
// в контексте тенанта (через AsyncLocalStorage), и миграция legacy-папки data/.

import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO_ROOT, TENANTS_DIR, tenantDir, tenantStore, type TenantContext } from "./paths.ts";
import { ensureDataLayout } from "./memory.ts";

// Базовый порт RPC-хаба; тенантам выдаются base, base+1, … (фактический порт пишется
// в lock каждого тенанта — MCP-прокси читает его оттуда).
export const HUB_BASE_PORT: number = Number(process.env.TG_HUB_PORT ?? 8765);

// Legacy single-tenant папка (до перехода на tenants/): <repo>/data или TG_DATA_DIR.
export function legacyDataDir(): string {
  return process.env.TG_DATA_DIR ? resolve(process.env.TG_DATA_DIR) : resolve(REPO_ROOT, "data");
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function legacyExists(): Promise<boolean> {
  return isDir(legacyDataDir());
}

function validateName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Недопустимое имя тенанта "${name}". Разрешены буквы, цифры, . _ -`);
  }
}

/** Имена всех тенантов (папки в TENANTS_DIR), по алфавиту. */
export async function listTenants(): Promise<string[]> {
  try {
    const entries = await readdir(TENANTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function tenantExists(name: string): Promise<boolean> {
  return isDir(tenantDir(name));
}

/** Контекст тенанта (имя + папка + порт хаба). index определяет порт base+index. */
export function tenantContext(name: string, index: number): TenantContext {
  return { name, dataDir: tenantDir(name), hubPort: HUB_BASE_PORT + index };
}

/** Выполнить fn в контексте тенанта: все path-функции укажут на его папку. */
export function withTenant<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStore.run(ctx, fn);
}

/** Создаёт папку тенанта и засевает структуру (data layout). */
export async function createTenant(name: string): Promise<string> {
  validateName(name);
  const dir = tenantDir(name);
  if (await isDir(dir)) throw new Error(`Тенант "${name}" уже существует: ${dir}`);
  await mkdir(dir, { recursive: true });
  await withTenant({ name, dataDir: dir, hubPort: HUB_BASE_PORT }, () => ensureDataLayout());
  return dir;
}

/** Переносит legacy-папку data/ в tenants/<name> (единообразный формат). */
export async function migrateLegacy(name: string): Promise<string> {
  validateName(name);
  const src = legacyDataDir();
  const dest = tenantDir(name);
  if (!(await isDir(src))) throw new Error(`Папка ${src} не найдена — мигрировать нечего.`);
  if (await isDir(dest)) throw new Error(`Тенант "${name}" уже существует: ${dest}`);
  await mkdir(TENANTS_DIR, { recursive: true });
  await rename(src, dest);
  return dest;
}
