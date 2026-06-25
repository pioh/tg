// Установка `tg` как ФОНОВОГО пользовательского сервиса — нативно для платформы:
//   Linux  → systemd --user (юнит ~/.config/systemd/user/tg-agent.service)
//   macOS  → launchd LaunchAgent (~/Library/LaunchAgents/com.tg.agent.plist)
//   Windows→ инструкция (Task Scheduler / автозагрузка) — авто-установку не делаем,
//            окружение слишком разнородное.
//
// Зачем: чтобы агент работал постоянно и сам поднимался после перезагрузки/логина,
// без необходимости держать открытый терминал с `bun run service`.
//
// После установки печатаем доку: где смотреть логи, как остановить/перезапустить,
// как удалить. Сервис запускается тем же `bun run src/service.ts` (один владелец
// сессии — это гарантирует lock-файл).

import { mkdir, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.ts";

export type OS = "linux" | "darwin" | "win32" | "other";

export function currentOS(): OS {
  const p = process.platform;
  if (p === "linux") return "linux";
  if (p === "darwin") return "darwin";
  if (p === "win32") return "win32";
  return "other";
}

/** Запущен ли сервис под менеджером (systemd/launchd) — тогда он умеет САМ
 *  перезапуститься простым выходом (менеджер поднимет заново). Юниты выставляют
 *  TG_MANAGED. Возвращает имя менеджера или null. */
export function managedBy(): string | null {
  return process.env.TG_MANAGED ?? null;
}

const SERVICE_NAME = "tg-agent"; // systemd
const LAUNCHD_LABEL = "com.tg.agent"; // launchd
const SERVICE_TS = join(REPO_ROOT, "src", "service.ts");
const BUN = process.execPath; // абсолютный путь к bun, который сейчас исполняется
const MAC_LOG = join(REPO_ROOT, "data", "service.log");

interface Run {
  code: number;
  out: string;
  err: string;
}
async function run(cmd: string[]): Promise<Run> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    return { code, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

// PATH сервиса: systemd --user / launchd дают МИНИМАЛЬНЫЙ env, и тогда `claude`/`codex`
// не находятся. Поэтому зашиваем текущий PATH + типовые пользовательские каталоги.
function servicePath(): string {
  const home = homedir();
  const extra = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ];
  const cur = process.env.PATH ? process.env.PATH.split(":") : [];
  return [...new Set([...cur, ...extra])].filter(Boolean).join(":");
}

const systemdUnitPath = () => join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
const launchdPlistPath = () => join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

function systemdUnit(): string {
  return `[Unit]
Description=tg — ИИ-агент личного Telegram
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
Environment=PATH=${servicePath()}
Environment=TG_MANAGED=systemd
ExecStart=${BUN} run ${SERVICE_TS}
# Restart=always — чтобы агент мог сам перезапуститься (после /update или /restart)
# простым выходом: systemd поднимет его заново. Чистая остановка — systemctl stop.
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function launchdPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN}</string>
    <string>run</string>
    <string>${SERVICE_TS}</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${servicePath()}</string>
    <key>TG_MANAGED</key><string>launchd</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${MAC_LOG}</string>
  <key>StandardErrorPath</key><string>${MAC_LOG}</string>
</dict>
</plist>
`;
}

export interface InstallResult {
  ok: boolean;
  manager: string;
  messages: string[];
  docs: string;
}

/** Ставит и запускает пользовательский сервис. start=false — только включить (если
 *  экземпляр уже работает вручную, чтобы не конфликтовать за lock). */
export async function installService(start = true): Promise<InstallResult> {
  const os = currentOS();
  const messages: string[] = [];

  if (os === "linux") {
    const path = systemdUnitPath();
    await mkdir(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    await writeFile(path, systemdUnit(), "utf8");
    messages.push(`Юнит записан: ${path}`);
    const reload = await run(["systemctl", "--user", "daemon-reload"]);
    if (reload.code !== 0) {
      messages.push("⚠️ systemctl --user недоступен (нет systemd user-сессии?). Юнит записан, но не активирован.");
      return { ok: false, manager: "systemd", messages, docs: serviceDocs(os) };
    }
    const enableArgs = start ? ["enable", "--now"] : ["enable"];
    const en = await run(["systemctl", "--user", ...enableArgs, `${SERVICE_NAME}.service`]);
    if (en.code === 0) {
      messages.push(start ? "✅ Сервис включён и запущен (systemd --user)." : "✅ Сервис включён (запустится автоматически).");
      // Чтобы работал и без активного логина — линджер (может потребовать прав).
      await run(["loginctl", "enable-linger", process.env.USER ?? ""]);
    } else {
      messages.push(`⚠️ Не удалось активировать: ${en.err || en.out}`);
      return { ok: false, manager: "systemd", messages, docs: serviceDocs(os) };
    }
    return { ok: true, manager: "systemd", messages, docs: serviceDocs(os) };
  }

  if (os === "darwin") {
    const path = launchdPlistPath();
    await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    await writeFile(path, launchdPlist(), "utf8");
    messages.push(`LaunchAgent записан: ${path}`);
    await run(["launchctl", "unload", path]); // на случай переустановки
    if (start) {
      const load = await run(["launchctl", "load", "-w", path]);
      if (load.code === 0) messages.push("✅ Сервис загружен и запущен (launchd).");
      else {
        messages.push(`⚠️ Не удалось загрузить: ${load.err || load.out}`);
        return { ok: false, manager: "launchd", messages, docs: serviceDocs(os) };
      }
    } else {
      messages.push("LaunchAgent записан; запустится при следующем логине (или `launchctl load -w`).");
    }
    return { ok: true, manager: "launchd", messages, docs: serviceDocs(os) };
  }

  // Windows / прочее — печатаем инструкцию, авто-установку не делаем.
  messages.push("Авто-установка сервиса на этой ОС не поддерживается — см. инструкцию ниже.");
  return { ok: false, manager: os === "win32" ? "windows" : "manual", messages, docs: serviceDocs(os) };
}

/** Установлен ли НАШ фоновый сервис под менеджером (есть юнит systemd / plist launchd).
 *  Нужно из мастера setup (он сам НЕ под менеджером, поэтому managedBy() там null), чтобы
 *  понять, можно ли перезапустить сервис автоматически и подхватить нового тенанта. */
export async function serviceIsManaged(): Promise<boolean> {
  const os = currentOS();
  const path = os === "linux" ? systemdUnitPath() : os === "darwin" ? launchdPlistPath() : null;
  if (!path) return false;
  return Bun.file(path).exists();
}

/** Перезапускает фоновый сервис через его менеджер (чтобы подхватил нового тенанта).
 *  Возвращает ok=false, если ОС/менеджер не поддерживает авто-рестарт. */
export async function restartService(): Promise<{ ok: boolean; message: string }> {
  const os = currentOS();
  if (os === "linux") {
    const r = await run(["systemctl", "--user", "restart", `${SERVICE_NAME}.service`]);
    if (r.code === 0) return { ok: true, message: "✅ Сервис перезапущен (systemd) — новый пользователь подхвачен." };
    return { ok: false, message: `⚠️ Не удалось перезапустить: ${r.err || r.out}` };
  }
  if (os === "darwin") {
    const r = await run(["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? ""}/${LAUNCHD_LABEL}`]);
    if (r.code === 0) return { ok: true, message: "✅ Сервис перезапущен (launchd) — новый пользователь подхвачен." };
    return { ok: false, message: `⚠️ Не удалось перезапустить: ${r.err || r.out}` };
  }
  return { ok: false, message: "Авто-перезапуск на этой ОС не поддерживается." };
}

export async function uninstallService(): Promise<{ ok: boolean; messages: string[] }> {
  const os = currentOS();
  const messages: string[] = [];
  if (os === "linux") {
    await run(["systemctl", "--user", "disable", "--now", `${SERVICE_NAME}.service`]);
    await unlink(systemdUnitPath()).catch(() => {});
    await run(["systemctl", "--user", "daemon-reload"]);
    messages.push("Сервис остановлен, отключён и удалён (systemd --user).");
    return { ok: true, messages };
  }
  if (os === "darwin") {
    await run(["launchctl", "unload", launchdPlistPath()]);
    await unlink(launchdPlistPath()).catch(() => {});
    messages.push("Сервис выгружен и удалён (launchd).");
    return { ok: true, messages };
  }
  messages.push("Авто-удаление на этой ОС не поддерживается.");
  return { ok: false, messages };
}

/** Платформенная справка: где логи, как остановить/запустить/удалить. */
export function serviceDocs(os: OS = currentOS()): string {
  if (os === "linux") {
    return [
      "📋 Управление сервисом (systemd --user):",
      "  • Логи (вживую):   journalctl --user -u tg-agent -f",
      "  • Логи (хвост):    journalctl --user -u tg-agent -n 200 --no-pager",
      "  • Статус:          systemctl --user status tg-agent",
      "  • Остановить:      systemctl --user stop tg-agent",
      "  • Запустить:       systemctl --user start tg-agent",
      "  • Перезапустить:   systemctl --user restart tg-agent",
      "  • Удалить:         bun run tg uninstall-service",
      "  • Работа без логина: loginctl enable-linger $USER (один раз; может спросить sudo)",
    ].join("\n");
  }
  if (os === "darwin") {
    return [
      "📋 Управление сервисом (launchd):",
      `  • Логи (вживую):   tail -f ${MAC_LOG}`,
      "  • Статус:          launchctl list | grep com.tg.agent",
      `  • Остановить:      launchctl unload ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
      `  • Запустить:       launchctl load -w ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
      `  • Перезапустить:   launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`,
      "  • Удалить:         bun run tg uninstall-service",
    ].join("\n");
  }
  if (os === "win32") {
    return [
      "📋 Запуск как фоновой задачи (Windows, вручную):",
      "  1) Планировщик задач → Создать задачу → Триггер «При входе в систему».",
      `  2) Действие: программа «${BUN}», аргументы «run ${SERVICE_TS}»,`,
      `     «Запускать в»: ${REPO_ROOT}`,
      "  3) Поставьте «Выполнять с наивысшими правами» по необходимости.",
      "  Готовая команда (PowerShell, от пользователя):",
      `     schtasks /Create /SC ONLOGON /TN tg-agent /TR "\\"${BUN}\\" run \\"${SERVICE_TS}\\"" /F`,
      "  • Логи: запускайте через обёртку с перенаправлением в файл, либо смотрите консоль.",
      "  • Остановить/удалить: schtasks /End /TN tg-agent ; schtasks /Delete /TN tg-agent /F",
    ].join("\n");
  }
  return "Автозапуск на этой ОС настройте средствами системы (запуск: bun run src/service.ts).";
}
