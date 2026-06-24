// Фабрика Telegram-клиента (mtcute, @mtcute/bun).
//
// Под Bun используется нативное хранилище на bun:sqlite — сессия сохраняется в
// data/session/account.session и автоматически переиспользуется при следующих
// запусках (повторный логин не нужен).
//
// ВАЖНО (единственный писатель сессии): к одному файлу сессии должен подключаться
// только ОДИН процесс одновременно. На практике это значит: не запускайте `login`
// при работающем `service`, и не держите проект открытым в интерактивном Claude
// Code/Codex (они сами поднимают MCP-сервер, который тоже подключается к сессии)
// одновременно с `service`. Иначе возможны конкуренция за bun:sqlite и рассинхрон
// состояния обновлений Telegram.

import { TelegramClient } from "@mtcute/bun";
import { mkdir } from "node:fs/promises";
import { sessionDir, sessionPath } from "../lib/paths.ts";
import { requireConfig } from "../lib/config.ts";

export async function createClient(): Promise<TelegramClient> {
  const cfg = await requireConfig();
  await mkdir(sessionDir(), { recursive: true });
  return new TelegramClient({
    apiId: cfg.apiId,
    apiHash: cfg.apiHash,
    storage: sessionPath(),
  });
}

/** true, если файл сессии существует (значит, ранее уже подключались/логинились).
 *  Это лёгкая эвристика; точную проверку авторизации даёт isLoggedIn(). */
export async function hasSession(): Promise<boolean> {
  // mtcute (bun:sqlite) создаёт файл ровно с именем storage-пути, без суффикса.
  return Bun.file(sessionPath()).exists();
}

/** Точная проверка: реально ли авторизованы. Подключается, зовёт getMe, отключается. */
export async function isLoggedIn(): Promise<{ name: string; username: string | null } | null> {
  if (!(await hasSession())) return null;
  const tg = await createClient();
  try {
    await tg.connect();
    const me = await tg.getMe();
    return { name: me.displayName, username: me.username ?? null };
  } catch {
    return null;
  } finally {
    await tg.destroy().catch(() => {});
  }
}
