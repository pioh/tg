import "./_env.ts";
import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { lockPath } from "../src/lib/paths.ts";
import { serviceRunning } from "../src/lib/lock.ts";

async function writeLock(obj: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(lockPath()), { recursive: true });
  await Bun.write(lockPath(), JSON.stringify(obj));
}

test("serviceRunning: старый lock с переиспользованным pid = stale (self-heal после ребута)", async () => {
  // Поднимаем СВОЙ сервер на порту lock, который отвечает 503 на /health → hubHealthy=false
  // детерминированно (не полагаемся на «случайно свободный» порт). Так проверяем именно
  // ветку «хаб мёртв» → решает pid+свежесть.
  const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 503 }) });
  const port = stub.port;
  try {
    // Старый lock: pid жив (берём свой process.pid), но startedAt давно — как после
    // перезагрузки, когда pid из lock занял ЧУЖОЙ процесс. Должен считаться stale.
    await writeLock({ pid: process.pid, port, token: "x", startedAt: new Date(Date.now() - 600000).toISOString() });
    expect(await serviceRunning()).toBeNull();

    // Свежий lock с живым pid (хаб ещё поднимается) — окно старта, считается «запущен».
    await writeLock({ pid: process.pid, port, token: "x", startedAt: new Date().toISOString() });
    expect(await serviceRunning()).not.toBeNull();

    // Мёртвый pid + старый lock — однозначно stale.
    await writeLock({ pid: 2147483646, port, token: "x", startedAt: new Date(Date.now() - 600000).toISOString() });
    expect(await serviceRunning()).toBeNull();
  } finally {
    stub.stop(true);
    await rm(lockPath()).catch(() => {});
  }
});
