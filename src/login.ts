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
    const pwd = ask("Облачный пароль (2FA): ");
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
    password: () => ask("Облачный пароль (2FA): "),
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
