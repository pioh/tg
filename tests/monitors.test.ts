import "./_env.ts";
import { test, expect } from "bun:test";
import { join } from "node:path";
import { DATA_DIR } from "../src/lib/paths.ts";
import { listMonitors, updateMonitor } from "../src/lib/monitors.ts";

const MON_PATH = join(DATA_DIR, "monitors.json");

test("миграция: монитор без enabled/action чинится (включён, notify)", async () => {
  // Воспроизводим старый баг: запись без обязательных полей.
  await Bun.write(MON_PATH, JSON.stringify({ monitors: [{ id: "m1", name: "x", chat: "123" }] }, null, 2));
  const list = await listMonitors();
  const m = list.find((x) => x.id === "m1")!;
  expect(m.enabled).toBe(true);
  expect(m.action).toBe("notify");
  expect(m.lastSeenMessageId).toBe(0);
});

test("updateMonitor частичным патчем НЕ затирает остальные поля", async () => {
  await Bun.write(
    MON_PATH,
    JSON.stringify({ monitors: [{ id: "m1", name: "x", chat: "123", action: "reply", enabled: true, lastSeenMessageId: 5 }] }, null, 2),
  );
  const updated = await updateMonitor("m1", { minIntervalSec: 30 });
  expect(updated?.action).toBe("reply");
  expect(updated?.enabled).toBe(true);
  expect(updated?.minIntervalSec).toBe(30);
  expect(updated?.lastSeenMessageId).toBe(5);
});

test("updateMonitor может выключить монитор (enabled=false)", async () => {
  await Bun.write(MON_PATH, JSON.stringify({ monitors: [{ id: "m1", name: "x", chat: "123", action: "notify", enabled: true, lastSeenMessageId: 0 }] }, null, 2));
  const updated = await updateMonitor("m1", { enabled: false });
  expect(updated?.enabled).toBe(false);
});
