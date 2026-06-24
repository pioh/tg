// Редактирование секретов перед логированием. Аудит-лог должен быть ПРОЗРАЧНЫМ
// (что/кому/статус), но НЕ должен хранить секреты открытым текстом: токен бота,
// api_hash, телефон, коды, пароли. Иначе data/actions.log превращается в файл с
// ключами от квартиры (даже локально это лишний риск).

// Поля, которые маскируем целиком.
const SECRET_KEYS = new Set([
  "token",
  "bottoken",
  "apihash",
  "api_hash",
  "phone",
  "code",
  "password",
  "pwd",
  "passwordhash",
  "hubtoken",
  "authorization",
]);

// Похоже на bot-токен (123456789:AA...) — маскируем где бы ни встретилось в строке.
const BOT_TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;

function maskString(s: string): string {
  return s.replace(BOT_TOKEN_RE, "<redacted-token>");
}

/** Рекурсивно заменяет значения секретных полей и токеноподобные строки на маску. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) out[k] = "<redacted>";
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Безопасная для лога строка из произвольных аргументов. */
export function redactToString(value: unknown, maxLen = 600): string {
  let s: string;
  try {
    s = JSON.stringify(redact(value) ?? {});
  } catch {
    s = "<args>";
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}
