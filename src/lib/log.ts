// Логгер. КРИТИЧНО: в MCP-сервере stdout зарезервирован под JSON-RPC, поэтому
// любые логи идут ТОЛЬКО в stderr. Используем этот логгер везде, чтобы случайно
// не сломать stdio-протокол MCP.

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function log(...args: unknown[]): void {
  console.error(`[tg ${stamp()}]`, ...args);
}

export function warn(...args: unknown[]): void {
  console.error(`[tg ${stamp()}] WARN`, ...args);
}

export function fail(...args: unknown[]): void {
  console.error(`[tg ${stamp()}] ERROR`, ...args);
}
