// MCP-сервер проекта tg — ТОНКИЙ ПРОКСИ к сервису-хабу.
//
// Сам с Telegram не работает (сессию не открывает): каждый инструмент перенаправляет
// вызов запущенному сервису через локальный RPC (см. src/lib/rpc.ts). Так с Telegram
// работает только один процесс — сервис. Если сервис не запущен, инструменты вернут
// понятную ошибку «запустите bun run service».
//
// Подхватывается автоматически: Claude Code (.mcp.json) и Codex (.codex/config.toml).
// Запуск вручную не нужен. stdout зарезервирован под JSON-RPC; логи — в stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log } from "../lib/log.ts";
import { hubCall } from "../lib/rpc.ts";

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ContentBlock[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}
function failResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new McpServer({ name: "tg", version: "0.5.1" });

// Прокси-обёртка: инструмент пересылает свои аргументы в хаб как операцию `op`.
function proxy(name: string, cfg: unknown, op: string): void {
  (server.registerTool as any)(name, cfg, async (args: Record<string, unknown> = {}) => {
    try {
      return ok(await hubCall(op, args));
    } catch (e) {
      return failResult(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

// ===== Telegram =====
proxy("tg_whoami", { title: "Кто я в Telegram", description: "Аккаунт: id, имя, username, телефон.", inputSchema: {} }, "whoami");
proxy(
  "tg_list_dialogs",
  { title: "Список диалогов", description: "Чаты: id, kind (user/bot/group/supergroup/channel), forum, непрочитанные, последнее сообщение.", inputSchema: { limit: z.number().int().min(1).max(200).optional() } },
  "list_dialogs",
);
proxy("tg_list_unread", { title: "Непрочитанные диалоги", description: "Только чаты с непрочитанными.", inputSchema: { limit: z.number().int().min(1).max(200).optional() } }, "list_unread");
proxy(
  "tg_get_history",
  { title: "История чата", description: "Сообщения с полным контекстом: media (тип+атрибуты), reply (+текст), forward, service, sender.", inputSchema: { chat: z.string(), limit: z.number().int().min(1).max(100).optional() } },
  "get_history",
);
proxy(
  "tg_send_message",
  { title: "Отправить сообщение", description: "Текст от имени пользователя. Третьим лицам — только если разрешено правилом (rules/50). Себе — chat \"me\".", inputSchema: { chat: z.string(), text: z.string().min(1), reply_to: z.number().int().optional() } },
  "send_message",
);
proxy("tg_search", { title: "Поиск сообщений", description: "Поиск в чате (chat) или глобально.", inputSchema: { query: z.string().min(1), chat: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } }, "search");
proxy(
  "tg_mark_read",
  { title: "Отметить прочитанным", description: "НЕ ИСПОЛЬЗУЙ по своей инициативе — владельцу важно видеть непрочитанные. Запрещено кодом без confirm=true; ставь confirm только по явной команде владельца. Чтение истории статус НЕ меняет.", inputSchema: { chat: z.string(), confirm: z.boolean().optional() } },
  "mark_read",
);
proxy("tg_resolve", { title: "Найти пользователя/чат", description: "Разрешить @username/id/телефон в id+имя+тип.", inputSchema: { query: z.string() } }, "resolve");
proxy("tg_send_file", { title: "Отправить файл", description: "Отправить файл с диска (с подписью).", inputSchema: { chat: z.string(), path: z.string(), caption: z.string().optional() } }, "send_file");
proxy("tg_list_topics", { title: "Список топиков", description: "Топики чата-форума (forum=true в tg_list_dialogs).", inputSchema: { chat: z.string(), limit: z.number().int().min(1).max(200).optional() } }, "list_topics");
proxy("tg_get_topic_history", { title: "История топика", description: "Сообщения конкретного топика форума.", inputSchema: { chat: z.string(), topic_id: z.number().int(), limit: z.number().int().min(1).max(100).optional() } }, "get_topic_history");
proxy("tg_react", { title: "Реакция на сообщение", description: "Поставить эмодзи-реакцию (👀 = «увидел»). Это НЕ отметка прочитанным — счётчик непрочитанных не сбрасывается.", inputSchema: { chat: z.string(), message_id: z.number().int(), emoji: z.string().optional() } }, "react");

// tg_view_media — особый: для картинок возвращаем изображение инлайн (vision).
(server.registerTool as any)(
  "tg_view_media",
  { title: "Посмотреть/скачать медиа", description: "Скачать медиа; для фото/картинок вернуть ИНЛАЙН (модель видит). Иначе — путь и метаданные.", inputSchema: { chat: z.string(), message_id: z.number().int() } },
  async ({ chat, message_id }: { chat: string; message_id: number }): Promise<ToolResult> => {
    try {
      const r = await hubCall<{ kind: string; path: string; fileName: string | null; note?: string; image?: { base64: string; mimeType: string } }>(
        "view_media",
        { chat, message_id },
      );
      const content: ContentBlock[] = [];
      if (r.image) content.push({ type: "image", data: r.image.base64, mimeType: r.image.mimeType });
      content.push({ type: "text", text: JSON.stringify({ kind: r.kind, path: r.path, fileName: r.fileName, note: r.note }, null, 2) });
      return { content };
    } catch (e) {
      return failResult(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ===== Мониторы =====
proxy(
  "monitor_add",
  {
    title: "Создать монитор",
    description: "Следить за чатом/топиком/человеком. Триггеры min_interval_sec и only_if_owner_silent_sec; фильтры from_user_id/keywords/mentions_me; action notify/draft/reply. Только по явной просьбе.",
    inputSchema: {
      name: z.string(),
      chat: z.string(),
      topic_id: z.number().int().optional(),
      from_user_id: z.number().int().optional(),
      keywords: z.array(z.string()).optional(),
      mentions_me: z.boolean().optional(),
      action: z.enum(["notify", "draft", "reply"]).optional(),
      min_interval_sec: z.number().int().min(0).optional(),
      only_if_owner_silent_sec: z.number().int().min(0).optional(),
    },
  },
  "monitor_add",
);
proxy("monitor_list", { title: "Список мониторов", description: "Все мониторы и их состояние.", inputSchema: {} }, "monitor_list");
proxy("monitor_remove", { title: "Удалить монитор", description: "Удалить по id.", inputSchema: { id: z.string() } }, "monitor_remove");
proxy(
  "monitor_update",
  { title: "Изменить монитор", description: "Включить/выключить или поменять параметры.", inputSchema: { id: z.string(), enabled: z.boolean().optional(), action: z.enum(["notify", "draft", "reply"]).optional(), min_interval_sec: z.number().int().min(0).optional(), only_if_owner_silent_sec: z.number().int().min(0).optional() } },
  "monitor_update",
);
// monitor_poll НЕ публикуется как инструмент: опрос двигает курсоры мониторов, это
// делает САМ сервис (live-цикл). Интерактивный агент получает сработки как события —
// иначе он украл бы событие у живого сервиса. То же для schedule_poll.

// ===== Разрешения на отправку (code-level allowlist) =====
proxy("permission_list", { title: "Кому можно писать", description: "Чаты с явным разрешением на отправку (кроме «me» и управляющего канала — им можно всегда).", inputSchema: {} }, "permission_list");
proxy("permission_grant", { title: "Разрешить писать в чат", description: "Выдать разрешение отвечать в чат. ТОЛЬКО по явной просьбе владельца.", inputSchema: { chat: z.string(), label: z.string().optional(), source: z.string().optional() } }, "permission_grant");
proxy("permission_revoke", { title: "Отозвать разрешение", description: "Запретить отправку в чат (убрать из allowlist).", inputSchema: { chat: z.string() } }, "permission_revoke");

// ===== Бот =====
proxy("bot_status", { title: "Статус бота", description: "Настроен ли сервисный бот, @username, ссылка.", inputSchema: {} }, "bot_status");
proxy("bot_set_token", { title: "Сохранить токен бота", description: "Сохранить токен от @BotFather (создание: /newbot через tg_send_message, см. rules/25-bot).", inputSchema: { token: z.string() } }, "bot_set_token");
// Обычный ответ человеку НЕ требует bot_send: текстовый вывод агента сервис сам шлёт
// человеку (MarkdownV2). bot_send нужен лишь для конкретного chat_id или проактивно.
proxy("bot_send", { title: "Бот пишет в конкретный чат", description: "Отправить сообщение бота в конкретный chat_id или проактивно (по расписанию). Для обычного ответа НЕ нужен — просто выведи текст. MarkdownV2; длинное режется само.", inputSchema: { text: z.string().min(1), chat_id: z.number().int().optional() } }, "bot_send");
proxy("bot_react", { title: "Реакция бота на сообщение", description: "Эмодзи-реакция на сообщение в чате бота (👀 = «увидел»).", inputSchema: { chat_id: z.number().int(), message_id: z.number().int(), emoji: z.string().optional() } }, "bot_react");

// ===== Кто может писать боту (allowlist; по умолчанию только владелец) =====
proxy("bot_users_list", { title: "Кто может писать боту", description: "Список пользователей (помимо владельца), которым разрешено писать сервисному боту.", inputSchema: {} }, "bot_users_list");
proxy("bot_user_allow", { title: "Разрешить писать боту", description: "Разрешить пользователю (id или @username) писать сервисному боту. Только по явной просьбе владельца.", inputSchema: { user: z.string(), note: z.string().optional() } }, "bot_user_allow");
proxy("bot_user_deny", { title: "Запретить писать боту", description: "Убрать пользователя из списка разрешённых писать боту.", inputSchema: { user: z.string() } }, "bot_user_deny");

// ===== Расписания =====
proxy("schedule_add", { title: "Создать расписание", description: "Периодическая задача: каждые every_sec выполнять instruction, доставлять deliver (bot/saved). Только по явной просьбе.", inputSchema: { name: z.string(), every_sec: z.number().int().min(30), instruction: z.string(), deliver: z.enum(["bot", "saved"]).optional() } }, "schedule_add");
proxy("schedule_list", { title: "Список расписаний", description: "Все расписания.", inputSchema: {} }, "schedule_list");
proxy("schedule_remove", { title: "Удалить расписание", description: "Удалить по id.", inputSchema: { id: z.string() } }, "schedule_remove");
// schedule_poll НЕ публикуется (двигает lastRunAt) — созревшие задачи отдаёт сервис как события.

// ===== Сессия агента (контекст) =====
proxy("session_status", { title: "Контекст/расход сессии", description: "Текущий размер контекста, число ходов и расход токенов/стоимость текущей сессии агента.", inputSchema: {} }, "session_status");
proxy("session_reset", { title: "Новая сессия агента", description: "Завершить текущую сессию и начать НОВУЮ (после этого хода). Вызывай, когда контекст сильно заполнен — СНАЧАЛА актуализируй handoff/память.", inputSchema: {} }, "session_reset");

// ===== Память =====
proxy("mem_bootstrap", { title: "Загрузить память", description: "Доктрина + правила + handoff + свежие qa + хвост progress. Вызывай первым.", inputSchema: {} }, "mem_bootstrap");
proxy("mem_rules_get", { title: "Получить правила", description: "rules/ + data/rules (оверрайд по имени).", inputSchema: {} }, "mem_rules_get");
proxy("mem_rule_set", { title: "Записать правило", description: "Сохранить правило в data/rules в финальном виде.", inputSchema: { name: z.string(), content: z.string() } }, "mem_rule_set");
proxy("mem_handoff_get", { title: "Прочитать handoff", description: "Текущий статус.", inputSchema: {} }, "mem_handoff_get");
proxy("mem_handoff_set", { title: "Обновить handoff", description: "Перезаписать актуальный статус.", inputSchema: { content: z.string() } }, "mem_handoff_set");
proxy("mem_progress_append", { title: "Дописать в progress", description: "Строка о значимом действии (append-only).", inputSchema: { line: z.string() } }, "mem_progress_append");
proxy("mem_qa_record", { title: "Записать просьбу дословно", description: "Дословно зафиксировать просьбу человека (не из Telegram).", inputSchema: { text: z.string(), source: z.string().optional() } }, "mem_qa_record");
proxy("mem_note_set", { title: "Записать в долговременную память", description: "Факт/договорённость/профиль в data/memory.", inputSchema: { name: z.string(), content: z.string() } }, "mem_note_set");
proxy("mem_note_get", { title: "Прочитать заметку памяти", description: "Полный текст заметки из data/memory по имени.", inputSchema: { name: z.string() } }, "mem_note_get");
proxy("mem_notes_search", { title: "Поиск в памяти", description: "Найти заметки в data/memory по подстроке (имя + фрагмент).", inputSchema: { query: z.string() } }, "mem_notes_search");
proxy("bot_chat_tail", { title: "Хвост переписки с ботом", description: "Последние строки data/bot-chat.md (что человек писал боту и что бот отвечал).", inputSchema: { lines: z.number().int().min(1).max(500).optional() } }, "bot_chat_tail");

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  log("MCP-прокси tg готов (операции идут через сервис-хаб)");
}
main().catch((error) => {
  log("Фатальная ошибка MCP-прокси:", error);
  process.exit(1);
});
