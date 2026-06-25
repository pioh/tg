// Единая карта путей проекта. Кросс-платформенно (mac/windows/linux) — все пути
// строятся от корня репозитория, вычисленного относительно этого файла.
//
// МУЛЬТИТЕНАНТНОСТЬ. Один сервис обслуживает НЕСКОЛЬКО независимых пользователей
// («тенантов»): у каждого своя рабочая папка (со своей сессией Telegram, ботом,
// памятью, правилами, мониторами и т.д.). Папки лежат в TENANTS_DIR (tenants/<имя>).
//
// Чтобы не тащить путь тенанта руками через каждую функцию, текущий тенант хранится в
// AsyncLocalStorage (tenantStore): сервис оборачивает обработку каждого тенанта в
// tenantStore.run(ctx, …), и все path-функции ниже отдают пути ЕГО папки. Вне контекста
// тенанта (CLI/тесты/дочерние процессы) путь берётся ТОЛЬКО из TG_DATA_DIR. Никакого
// единого «data/»-режима больше нет — всё работает на тенантах (tenants/<имя>).
//
// ВАЖНО: жёсткое разделение src/ (код) и рабочих папок (личные данные, не в git).

import { resolve, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// src/lib/paths.ts -> корень репозитория на два уровня выше.
export const REPO_ROOT: string = resolve(import.meta.dir, "..", "..");

// Базовые (универсальные, коммитятся в git) промпты-правила — общие для всех тенантов.
export const RULES_DIR: string = resolve(REPO_ROOT, "rules");

// Корень рабочих папок тенантов (по умолчанию <repo>/tenants, можно переопределить).
export const TENANTS_DIR: string = process.env.TG_TENANTS_DIR
  ? resolve(process.env.TG_TENANTS_DIR)
  : resolve(REPO_ROOT, "tenants");

// Путь к MCP-серверу — используется при программном запуске движка.
export const MCP_SERVER_PATH: string = resolve(REPO_ROOT, "src", "mcp", "server.ts");

export interface TenantContext {
  /** имя тенанта (= имя папки в tenants/). */
  name: string;
  /** абсолютный путь рабочей папки тенанта. */
  dataDir: string;
  /** порт RPC-хаба этого тенанта. */
  hubPort: number;
}

/** Контекст текущего тенанта (см. описание модуля). */
export const tenantStore = new AsyncLocalStorage<TenantContext>();

/** Рабочая папка ТЕКУЩЕГО тенанта. Вне контекста — только из TG_DATA_DIR (тесты/дочерние
 *  процессы); если и его нет — ошибка (никакого скрытого «data/» по умолчанию). */
export function dataDir(): string {
  const ctx = tenantStore.getStore();
  if (ctx) return ctx.dataDir;
  if (process.env.TG_DATA_DIR) return resolve(process.env.TG_DATA_DIR);
  throw new Error("Нет рабочей папки: код выполняется вне контекста тенанта и без TG_DATA_DIR. Укажите пользователя (tenant).");
}

/** Имя текущего тенанта, если есть контекст. */
export function currentTenant(): TenantContext | undefined {
  return tenantStore.getStore();
}

// Имя тенанта = имя папки в tenants/. Разрешены ТОЛЬКО буквы/цифры/_/- (без точки и
// слэшей): иначе возможен path traversal («../data» ушёл бы из tenants/ и снова прочитал
// legacy data/ — скрытый фолбэк, который запрещён). Это ЕДИНЫЙ источник правды; tenantDir
// валидирует на месте, поэтому любой путь к папке тенанта безопасен по построению.
export function isTenantName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}
export function assertTenantName(name: string): void {
  if (!isTenantName(name)) {
    throw new Error(`Недопустимое имя тенанта "${name}". Разрешены только буквы, цифры, _ и - (без точек и слэшей).`);
  }
}

/** Папка тенанта по имени (без активации контекста). Имя валидируется (anti-traversal). */
export function tenantDir(name: string): string {
  assertTenantName(name);
  return join(TENANTS_DIR, name);
}

// --- Пути внутри рабочей папки текущего тенанта (функции, т.к. зависят от контекста) ---

// Пользовательские оверрайды правил (тот же basename переопределяет базовый).
export const dataRulesDir = (): string => join(dataDir(), "rules");
// Хранилище Telegram-сессии (bun:sqlite). Файл получит суффикс .session.
export const sessionDir = (): string => join(dataDir(), "session");
export const sessionPath = (): string => join(sessionDir(), "account");
// Дословные просьбы человека: <data>/qa/<YYYY-MM-DD>.md
export const qaDir = (): string => join(dataDir(), "qa");
// Долговременная структурированная память.
export const memoryDir = (): string => join(dataDir(), "memory");
// Скачанные из Telegram файлы.
export const downloadsDir = (): string => join(dataDir(), "downloads");
// Актуальный статус (handoff), который читает каждый следующий агент.
export const handoffPath = (): string => join(dataDir(), "handoff.md");
// Append-only журнал значимых действий/достижений.
export const progressPath = (): string => join(dataDir(), "progress.txt");
// Прозрачный журнал ВСЕХ действий агента через MCP (кто/что/кому).
export const actionsPath = (): string => join(dataDir(), "actions.log");
// Полная переписка человека с сервисным ботом (вход и ответы) — на диске.
export const botChatPath = (): string => join(dataDir(), "bot-chat.md");
// Внутреннее состояние сервиса (курсоры опроса и т.п.).
export const statePath = (): string => join(dataDir(), "state.json");
// Личная конфигурация (api_id/api_hash, выбор движка и пр.). Не коммитится.
export const configPath = (): string => join(dataDir(), "config.json");
// Легаси-файл разрешений старых тенантов. Кодом больше НЕ используется для решения «кому
// писать» (отправка свободна), кроме блок-листа send_file (его нельзя слать наружу). Не коммитится.
export const permissionsPath = (): string => join(dataDir(), "permissions.json");
// Кто может писать сервисному боту (allowlist; по умолчанию только владелец).
export const botUsersPath = (): string => join(dataDir(), "bot-users.json");
// Мониторы и расписания тенанта.
export const monitorsPath = (): string => join(dataDir(), "monitors.json");
export const schedulesPath = (): string => join(dataDir(), "schedules.json");
// Lock + рантайм-координаты сервиса тенанта (pid, порт хаба, bearer-токен RPC).
export const lockPath = (): string => join(dataDir(), "service.lock");
