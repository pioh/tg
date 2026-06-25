// Мастер настройки `bun run setup [имя]` — ведёт ИИ-агент. МУЛЬТИТЕНАНТНЫЙ: настраивает
// ОДНОГО пользователя (тенанта) — его папку tenants/<имя> со своей сессией и ботом.
//
// Поток:
//   1) определить имя тенанта (аргумент или спросить); создать папку, если нет;
//   2) вход в Telegram этого тенанта (QR — единственный механический шаг);
//   3) поднять ВРЕМЕННЫЙ сервис только для этого тенанта (TG_ONLY_TENANT), дождаться хаба;
//   4) запустить интерактивную сессию движка (claude/codex) с миссией настройки — её
//      MCP-прокси получит координаты хаба тенанта ЯВНО в env (TG_HUB_PORT/TG_HUB_TOKEN
//      из его lock); TG_DATA_DIR — для прямого чтения файлов тенанта агентом;
//   5) остановить временный сервис; предложить установить постоянный фоновый сервис.

import { ensureDataLayout } from "./lib/memory.ts";
import { isLoggedIn, hasSession } from "./telegram/client.ts";
import { loadConfig } from "./lib/config.ts";
import { readLock, serviceRunning } from "./lib/lock.ts";
import { REPO_ROOT, tenantDir, type TenantContext } from "./lib/paths.ts";
import { createTenant, listTenants, tenantContext, tenantExists, withTenant, isTenantName } from "./lib/tenants.ts";
import { installService, serviceDocs, currentOS, serviceIsManaged, restartService } from "./lib/service-install.ts";

const SETUP_MISSION = `Ты — дружелюбный ассистент настройки личного Telegram-агента (проект tg).
Проведи меня через настройку с МИНИМУМОМ действий с моей стороны: думай и предлагай
сам, спрашивай только когда реально нужно моё решение или действие.

Сделай по шагам, по-русски, кратко:
1. Прочитай rules/00-agent-core.md, rules/10-memory-hierarchy.md, rules/25-bot.md и
   вызови mem_bootstrap — пойми текущее состояние и память.
2. Проверь bot_status. Если сервисный бот ещё НЕ настроен — предложи создать его и
   САМ придумай хорошее имя и @username (на основе моего профиля, tg_whoami; username
   должен заканчиваться на 'bot'). Покажи предложение, спроси короткое «ок?».
   После подтверждения создай бота сам: пиши @BotFather через tg_send_message
   (/newbot → имя → username; читай ответы tg_get_history; если username занят —
   придумай другой и повтори), забери токен и сохрани bot_set_token. Затем САМ
   зарегистрируй меня у бота — НЕ проси меня жать Start вручную: отправь боту "/start"
   от моего имени (tg_send_message в чат @<username> с текстом "/start"). Проверь
   bot_status: ownerChatKnown должно стать true (если ещё нет — подожди и проверь снова).
   Дай мне ссылку t.me/<username>.
3. Спроси (одним сообщением, без давления), хочу ли я что-то базовое: последить за
   кем-то (монитор), периодическую сводку (расписание), общий чат с ботом для семьи
   (тогда подскажи: добавь бота в группу и отправь там /here, и выключи privacy-mode
   у @BotFather). Что попрошу — настрой инструментами и зафиксируй правило в data/rules.
4. Очень кратко перечисли возможности и упомяни команды бота /help и /start. После
   твоего завершения мастер сам предложит установить фоновый сервис.

Действуй автономно, не заставляй меня выполнять лишние механические шаги.`;

const SETUP_PERSONA = `Сейчас идёт интерактивная НАСТРОЙКА (bun run setup). Будь кратким, дружелюбным,
проактивным: предлагай имена/значения сам, минимизируй мои действия. Не делай
рискованного без подтверждения. Память и правила меняй только в data/.`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ask(question: string): string {
  const a = prompt(question);
  return (a ?? "").trim();
}
function askYesNo(question: string, def = true): boolean {
  const ans = prompt(`${question} ${def ? "[Y/n]" : "[y/N]"} `);
  if (ans === null) return def;
  const s = ans.trim().toLowerCase();
  if (s === "") return def;
  return s === "y" || s === "yes" || s === "д" || s === "да";
}

/** Запущен ли фоновый сервис ХОТЬ У ОДНОГО тенанта (проверяем lock КАЖДОГО в его
 *  контексте). Нужно ДО старта временного child: если managed-сервис уже обслуживает
 *  ДРУГИХ тенантов, у нового пользователя ещё нет своего lock (preRunning=false), но
 *  сервис всё равно работает — его надо ПЕРЕЗАПУСТИТЬ, чтобы он подхватил новенького,
 *  а не ставить заново. (Тот же подход, что в CLI install-service.) */
async function anyServiceRunning(): Promise<boolean> {
  const names = await listTenants();
  for (let i = 0; i < names.length; i++) {
    const ctx = tenantContext(names[i]!, i);
    if (await withTenant(ctx, () => serviceRunning())) return true;
  }
  return false;
}

/** Свободный TCP-порт (чтобы временный сервис не конфликтовал с уже запущенным на 8765). */
function findFreePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port;
  s.stop(true);
  if (typeof p !== "number" || p <= 0) throw new Error("не удалось выделить свободный порт");
  return p;
}

/** Запускает сервис ТОЛЬКО для этого тенанта (TG_ONLY_TENANT) на свободном порту и ждёт
 *  его хаб (serviceRunning читает порт из lock тенанта, так что фактический порт неважен). */
async function startServiceChild(ctx: TenantContext): Promise<ReturnType<typeof Bun.spawn>> {
  const port = findFreePort();
  const proc = Bun.spawn(["bun", "run", "src/service.ts"], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TG_ONLY_TENANT: ctx.name, TG_HUB_PORT: String(port) },
  });
  for (let i = 0; i < 60; i++) {
    if (await withTenant(ctx, () => serviceRunning())) return proc;
    await sleep(500);
  }
  // Хаб не поднялся за таймаут — НЕ оставляем висеть лишний процесс: убиваем и ждём выхода.
  proc.kill();
  await proc.exited.catch(() => {});
  throw new Error("Сервис не поднялся за 30с. Проверьте вход в Telegram и логи выше.");
}

// Решение по фоновому сервису ПОСЛЕ настройки. Передаём флаги, посчитанные ДО старта
// временного child (иначе наш собственный child-сервис тенанта исказил бы картину):
//   externalServiceRunning — работает ли фоновый сервис ХОТЬ У ОДНОГО тенанта (по всем
//                            тенантам, не только у нового);
//   managedUnitExists      — есть ли установленный юнит менеджера (systemd/launchd).
async function offerServiceInstall(externalServiceRunning: boolean, managedUnitExists: boolean): Promise<void> {
  const os = currentOS();
  if (os === "win32" || os === "other") {
    console.log("\nЧтобы агент работал в фоне постоянно (Windows):\n");
    console.log(serviceDocs(os) + "\n");
    return;
  }
  const mgr = os === "linux" ? "systemd --user" : "launchd";

  // Если managed-сервис УЖЕ установлен (юнит есть), он перечисляет тенантов только при
  // старте — нового пользователя подхватит лишь после РЕСТАРТА (а не `enable --now`, который
  // на уже активном юните ничего не перезапустит). Поэтому даже если у нового тенанта ещё нет
  // своего lock, но managed-сервис обслуживает других, предлагаем перезапуск и делаем его сами.
  if (managedUnitExists) {
    if (askYesNo(`\nФоновый сервис уже установлен (${mgr}). Перезапустить его сейчас, чтобы он подхватил нового пользователя?`)) {
      const r = await restartService();
      console.log("  " + r.message);
      if (!r.ok) console.log("  Перезапусти вручную: systemctl --user restart tg-agent (или launchctl).");
    } else {
      console.log("  Ок. Подхватит после перезапуска: systemctl --user restart tg-agent (или launchctl).");
    }
    console.log("");
    return;
  }

  // Юнита менеджера нет, но сервис всё же работает (запущен вручную, bun run service) —
  // авто-рестарта нет, только подсказка.
  if (externalServiceRunning) {
    console.log("\n  ⚠️ Сервис запущен вручную. Перезапусти его (Ctrl+C + bun run service), чтобы подхватить нового пользователя.\n");
    return;
  }

  if (!askYesNo(`\nУстановить агента как фоновый сервис (${mgr}), чтобы работал постоянно и сам стартовал после перезагрузки?`)) {
    console.log("Ок, не ставлю. Можно потом: bun run tg install-service\n");
    return;
  }
  const res = await installService(true);
  console.log("");
  for (const m of res.messages) console.log("  " + m);
  console.log("\n" + res.docs + "\n");
}

async function main(): Promise<void> {
  console.log("Настройка tg. Один шаг механический (вход в Telegram), дальше всё делает агент.\n");

  // 1) Имя тенанта (пользователя/папки). Без дефолтов — спрашиваем явно.
  let name = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "";
  while (!isTenantName(name)) {
    name = ask("Имя для этого пользователя/папки (латиница/цифры/_/-, напр. me, work, family): ");
    if (!isTenantName(name)) console.log("Только латиница, цифры, _ и - (без точек и пробелов) — попробуй ещё раз.");
  }
  if (!(await tenantExists(name))) {
    await createTenant(name);
    console.log(`Создал папку tenants/${name}.\n`);
  }
  const ctx = tenantContext(name, 0);

  // Дальше всё, что читает папку тенанта, — в его контексте.
  await withTenant(ctx, () => ensureDataLayout());

  // preRunning — работает ли сервис именно ЭТОГО тенанта (по его lock): тогда вход и
  // временный child не нужны. Отдельно — состояние фонового сервиса ПО ВСЕМ тенантам и
  // наличие managed-юнита: считаем их ДО старта временного child (иначе наш собственный
  // child-сервис тенанта исказил бы картину) и используем для решения по сервису в конце.
  const preRunning = Boolean(await withTenant(ctx, () => serviceRunning()));
  const externalServiceRunning = await anyServiceRunning();
  const managedUnitExists = await serviceIsManaged();

  // 2) Вход в Telegram этого тенанта.
  if (preRunning) {
    console.log(`✅ Сервис тенанта «${name}» уже запущен — вход не требуется.\n`);
  } else if (await withTenant(ctx, () => isLoggedIn())) {
    console.log("✅ Вход в Telegram уже выполнен.\n");
  } else {
    console.log("Шаг входа: откроется вход по QR (отсканируй с телефона).\n");
    const login = Bun.spawn(["bun", "run", "src/login.ts", name], { cwd: REPO_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    await login.exited;
    if (!(await withTenant(ctx, () => hasSession()))) {
      console.log(`\nВход не завершён. Запусти мастер снова: bun run setup ${name}`);
      process.exit(1);
    }
    console.log("");
  }

  // 3) Поднимаем временный сервис ТОЛЬКО для этого тенанта (нужен для инструментов агента).
  let child: ReturnType<typeof Bun.spawn> | null = null;
  if (preRunning) {
    console.log("✅ Сервис уже запущен — использую его.\n");
  } else {
    console.log("Запускаю сервис в фоне (нужен для инструментов агента)…\n");
    child = await startServiceChild(ctx);
    console.log("✅ Сервис готов.\n");
  }

  // 4) Интерактивная сессия движка. Координаты хаба передаём ЯВНО в env (TG_HUB_PORT/
  // TG_HUB_TOKEN из lock тенанта) — без них MCP-прокси не выберет тенанта (set_context),
  // и это правильный, однозначный путь (тот же, что у live-MCP сервиса). TG_DATA_DIR
  // оставляем для прямого чтения файлов тенанта агентом.
  const engine = (await withTenant(ctx, () => loadConfig())).agent;
  const lock = await withTenant(ctx, () => readLock());
  if (!lock) throw new Error(`Не нашёл lock тенанта «${name}» — сервис не поднялся. Запусти заново: bun run setup ${name}`);
  console.log(`Запускаю ассистента настройки (${engine})…\n`);
  const cmd = engine === "codex"
    ? ["codex", `${SETUP_PERSONA}\n\n${SETUP_MISSION}`]
    : ["claude", "--append-system-prompt", SETUP_PERSONA, SETUP_MISSION];

  let code = 0;
  try {
    const agent = Bun.spawn(cmd, {
      cwd: REPO_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, TG_DATA_DIR: tenantDir(name), TG_HUB_PORT: String(lock.port), TG_HUB_TOKEN: lock.token },
    });
    code = (await agent.exited) ?? 0;
  } catch {
    console.log(`Не удалось запустить «${cmd[0]}». Установи его и повтори, или открой проект в Claude Code/Codex и скажи: «настрой меня».`);
    code = 1;
  }

  // 5) Останавливаем временный сервис (если запускали сами).
  if (child) {
    console.log("\nОстанавливаю временный сервис настройки…");
    child.kill();
    await child.exited.catch(() => {});
  }

  // 6) Предлагаем поставить/перезапустить постоянный фоновый сервис (он поднимет ВСЕХ
  // тенантов). Флаги посчитаны ДО старта временного child — managed-сервис, обслуживающий
  // ДРУГИХ тенантов, корректно детектируется (нужен рестарт, не повторная установка).
  await offerServiceInstall(externalServiceRunning, managedUnitExists).catch((e) =>
    console.log("Установка сервиса пропущена:", e instanceof Error ? e.message : e),
  );

  console.log(`Готово. Запустить всех пользователей вручную: bun run service. Добавить ещё одного: bun run setup <имя>.\n`);
  process.exit(code);
}

main().catch((err) => {
  console.error("Ошибка мастера:", err instanceof Error ? err.message : err);
  process.exit(1);
});
