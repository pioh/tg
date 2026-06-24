// Интерактивный вход в личный Telegram.
//   bun run login          — вход по QR-коду (по умолчанию): сканируете QR с телефона
//   bun run login --code   — вход по коду (телефон → код → 2FA)
//
// QR — основной способ: он надёжнее, когда код «via app» не доходит. На телефоне с
// Telegram откройте Настройки → Устройства → Подключить устройство и наведите камеру
// на QR из терминала. Облачный пароль (2FA), если включён, спросят после скана.
//
// api_id/api_hash берутся из конфигурации (есть встроенные по умолчанию). Сессия
// сохраняется в data/session/account.session (bun:sqlite) и переиспользуется.
//
// НЕ запускайте login, пока работает сервис: хранилище сессии открывает один процесс.

import { TelegramClient, tl } from "@mtcute/bun";
import type { SentCode, User } from "@mtcute/bun";
import qrcode from "qrcode-terminal";
import { mkdir } from "node:fs/promises";
import { requireConfig } from "./lib/config.ts";
import { SESSION_DIR, SESSION_PATH } from "./lib/paths.ts";
import { ensureDataLayout } from "./lib/memory.ts";

function ask(question: string): string {
  const ans = prompt(question);
  if (ans === null) {
    console.error("Прервано.");
    process.exit(1);
  }
  return ans.trim();
}

// Ввод секрета (пароль 2FA) со СКРЫТИЕМ: вместо символов печатаются звёздочки, чтобы
// пароль не светился в терминале/в истории/в плече соседа. Работает в raw-режиме TTY;
// в неинтерактивном режиме (пайп) откатывается на обычный ввод (эхо не отключить).
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  // Нет TTY или нет raw-режима (некоторые окружения/Windows-консоли) — откатываемся на
  // обычный ввод (без скрытия эхо это не сделать кроссплатформенно).
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return Promise.resolve(ask(question));
  process.stdout.write(question);
  return new Promise<string>((resolve) => {
    let buf = "";
    const prevRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (restorePause: boolean) => {
      stdin.setRawMode(prevRaw);
      if (restorePause) stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (data: Buffer) => {
      for (const ch of data.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          finish(true);
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (ch === "") {
          // Ctrl+C
          finish(false);
          process.stdout.write("\n");
          process.exit(1);
        }
        if (ch === "" || ch === "\b") {
          // Backspace / Delete
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue; // прочие управляющие символы игнорируем
        buf += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

// sendCode может вернуть User (если вход уже не требуется) — тогда сразу завершаем.
function requireSentCode(r: SentCode | User): SentCode {
  if ("phoneCodeHash" in r) return r;
  console.log(`✅ Уже выполнен вход: ${r.displayName}${r.username ? ` (@${r.username})` : ""}`);
  process.exit(0);
}

function explainDelivery(sent: SentCode, phone: string): void {
  console.log("");
  switch (sent.type) {
    case "app":
      console.log(
        "📨 Код отправлен ВНУТРЬ Telegram (не по SMS).\n" +
          "   Откройте Telegram на другом устройстве, где вы УЖЕ вошли (телефон/desktop/web),\n" +
          "   и найдите чат «Telegram» (официальный, синяя галочка, отправитель 777000) — код там.\n" +
          "   👉 Не приходит / нет доступа к тому устройству? Прервите (Ctrl+C) и войдите по QR:\n" +
          "      bun run login --qr",
      );
      break;
    case "sms":
    case "sms_word":
    case "sms_phrase":
      console.log(`📨 Код отправлен по SMS на ${phone}.`);
      if (sent.beginning) console.log(`   Сообщение начинается с: "${sent.beginning}…"`);
      break;
    case "call":
      console.log("📞 Код придёт голосовым звонком — вам продиктуют цифры.");
      break;
    case "missed_call":
    case "flash_call":
      console.log("📞 Код — последние 5 цифр номера входящего (сброшенного) звонка.");
      break;
    case "fragment":
      console.log("📨 Код отправлен на анонимный номер Fragment (fragment.com).");
      break;
    case "email":
      console.log("📧 Код отправлен на привязанную почту.");
      break;
    default:
      console.log(`📨 Код отправлен (тип доставки: ${sent.type}).`);
  }
  if (sent.nextType && sent.nextType !== "none") {
    console.log(`   Не приходит? Введите resend — следующий способ: ${sent.nextType}.`);
  }
  console.log("   Если включён облачный пароль (2FA), его спросят ПОСЛЕ кода.\n");
}

async function loginByCode(tg: TelegramClient): Promise<User> {
  const phone = ask("Телефон (например +79991234567): ");
  let sent = requireSentCode(await tg.sendCode({ phone }));
  explainDelivery(sent, phone);

  for (;;) {
    const code = ask('Код подтверждения (или "resend" / "qr"): ');

    if (code.toLowerCase() === "qr") {
      console.log("Переключаюсь на вход по QR…\n");
      return loginByQr(tg);
    }
    if (code.toLowerCase() === "resend") {
      if (!sent.nextType || sent.nextType === "none") {
        console.log("Другого способа доставки нет. Войдите по QR: прервите и `bun run login --qr`.");
        continue;
      }
      sent = await tg.resendCode({ phone, phoneCodeHash: sent.phoneCodeHash });
      explainDelivery(sent, phone);
      continue;
    }

    try {
      return await tg.signIn({ phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: code });
    } catch (e) {
      if (tl.RpcError.is(e, "SESSION_PASSWORD_NEEDED")) {
        return askPassword(tg);
      } else if (tl.RpcError.is(e, "PHONE_CODE_INVALID")) {
        console.log("Неверный код, попробуйте ещё раз.");
      } else if (tl.RpcError.is(e, "PHONE_CODE_EXPIRED")) {
        console.log("Код истёк, запрашиваю новый…");
        sent = requireSentCode(await tg.sendCode({ phone }));
        explainDelivery(sent, phone);
      } else {
        throw e;
      }
    }
  }
}

async function askPassword(tg: TelegramClient): Promise<User> {
  for (;;) {
    const pwd = await askHidden("Облачный пароль (2FA): ");
    try {
      return await tg.checkPassword(pwd);
    } catch (pe) {
      if (tl.RpcError.is(pe, "PASSWORD_HASH_INVALID")) {
        console.log("Неверный пароль 2FA, попробуйте ещё раз.");
        continue;
      }
      throw pe;
    }
  }
}

async function loginByQr(tg: TelegramClient): Promise<User> {
  console.log(
    "Вход по QR-коду. На телефоне с Telegram: Настройки → Устройства →\n" +
      "Подключить устройство (Link Desktop Device) и наведите камеру на QR ниже.\n" +
      "(Предпочитаете вход по коду? Прервите и запустите: bun run login --code)\n",
  );
  return tg.signInQr({
    onUrlUpdated: (url) => {
      qrcode.generate(url, { small: true });
      console.log("↑ Отсканируйте этот QR в Telegram (обновляется автоматически).\n");
    },
    onQrScanned: () => console.log("QR отсканирован, завершаю вход…"),
    password: () => askHidden("Облачный пароль (2FA): "),
    invalidPasswordCallback: () => {
      console.log("Неверный пароль 2FA, попробуйте ещё раз.");
    },
  });
}

async function main(): Promise<void> {
  await ensureDataLayout();
  await mkdir(SESSION_DIR, { recursive: true });

  const cfg = await requireConfig();
  const tg = new TelegramClient({ apiId: cfg.apiId, apiHash: cfg.apiHash, storage: SESSION_PATH });
  await tg.connect();

  // Уже залогинены?
  const existing = await tg.getMe().catch(() => null);
  if (existing) {
    console.log(`✅ Уже выполнен вход: ${existing.displayName}${existing.username ? ` (@${existing.username})` : ""}`);
    await tg.destroy();
    process.exit(0);
  }

  // По умолчанию — вход по QR (надёжнее). Вход по коду — через флаг --code.
  const useCode = process.argv.includes("--code");
  const user = useCode ? await loginByCode(tg) : await loginByQr(tg);

  console.log(`\n✅ Вход выполнен: ${user.displayName}${user.username ? ` (@${user.username})` : ""}`);
  console.log("Сессия сохранена. Теперь можно запускать `bun run service`.\n");

  await tg.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("Ошибка входа:", err instanceof Error ? err.message : err);
  process.exit(1);
});
