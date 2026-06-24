// Единая карта путей проекта. Кросс-платформенно (mac/windows/linux) — все пути
// строятся от корня репозитория, вычисленного относительно этого файла.
//
// ВАЖНО: жёсткое разделение, которое требует ТЗ:
//   - src/   — исходный код (этот файл лежит в src/lib/, корень = ../..)
//   - data/  — рабочая папка агента: сессия, правила-оверрайды, QA, память,
//              handoff и progress. Полностью игнорируется git (личные данные).
//
// data-папку можно переопределить переменной окружения TG_DATA_DIR.

import { resolve } from "node:path";

// src/lib/paths.ts -> корень репозитория на два уровня выше.
export const REPO_ROOT: string = resolve(import.meta.dir, "..", "..");

// Базовые (универсальные, коммитятся в git) промпты-правила.
export const RULES_DIR: string = resolve(REPO_ROOT, "rules");

// Рабочая папка. По умолчанию <repo>/data, можно переопределить TG_DATA_DIR.
export const DATA_DIR: string = process.env.TG_DATA_DIR
  ? resolve(process.env.TG_DATA_DIR)
  : resolve(REPO_ROOT, "data");

// Пользовательские оверрайды правил (тот же basename переопределяет базовый).
export const DATA_RULES_DIR: string = resolve(DATA_DIR, "rules");

// Хранилище Telegram-сессии (bun:sqlite). Файл получит суффикс .session.
export const SESSION_DIR: string = resolve(DATA_DIR, "session");
export const SESSION_PATH: string = resolve(SESSION_DIR, "account");

// Дословные просьбы человека к агенту: data/qa/<YYYY-MM-DD>.md
export const QA_DIR: string = resolve(DATA_DIR, "qa");

// Долговременная структурированная память (люди, чаты, факты, договорённости).
export const MEMORY_DIR: string = resolve(DATA_DIR, "memory");

// Скачанные из Telegram файлы.
export const DOWNLOADS_DIR: string = resolve(DATA_DIR, "downloads");

// Актуальный статус (handoff), который читает каждый следующий агент.
export const HANDOFF_PATH: string = resolve(DATA_DIR, "handoff.md");

// Append-only журнал значимых действий/достижений.
export const PROGRESS_PATH: string = resolve(DATA_DIR, "progress.txt");

// Прозрачный журнал ВСЕХ действий агента через MCP (кто/что/кому). Пишет сервер,
// читает сервис и выводит в свою консоль. Технический аудит-лог.
export const ACTIONS_PATH: string = resolve(DATA_DIR, "actions.log");

// Полная переписка человека с сервисным ботом (вход и ответы) — на диске, чтобы
// любой следующий агент знал контекст разговора.
export const BOT_CHAT_PATH: string = resolve(DATA_DIR, "bot-chat.md");

// Внутреннее состояние сервиса (курсоры опроса и т.п.).
export const STATE_PATH: string = resolve(DATA_DIR, "state.json");

// Личная конфигурация (api_id/api_hash, выбор движка и пр.). Не коммитится.
export const CONFIG_PATH: string = resolve(DATA_DIR, "config.json");

// Code-level allowlist отправки сообщений (кому агент может писать). Не коммитится.
export const PERMISSIONS_PATH: string = resolve(DATA_DIR, "permissions.json");

// Lock + рантайм-координаты запущенного сервиса (pid, порт хаба, bearer-токен RPC).
// Гарантирует «один сервис — один владелец сессии» и даёт MCP-прокси найти хаб.
export const LOCK_PATH: string = resolve(DATA_DIR, "service.lock");

// Путь к MCP-серверу — используется при программном запуске движка.
export const MCP_SERVER_PATH: string = resolve(REPO_ROOT, "src", "mcp", "server.ts");
