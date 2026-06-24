// Расписания — периодические задачи агента (в отличие от мониторов, которые
// событийные). Пример: «каждые 5 минут — сводка новых сообщений в бота».
//
// Хранилище: data/schedules.json. На каждом тике сервис зовёт evaluateSchedules():
// возвращает «созревшие» задачи; агент выполняет их инструкцию и доставляет
// результат (deliver: bot — через сервисного бота; saved — в «Избранное»).

import { schedulesPath } from "./paths.ts";
import { atomicWriteJson } from "./atomic.ts";

export type DeliverTo = "bot" | "saved";

export interface Schedule {
  id: string;
  name: string;
  everySec: number;
  instruction: string; // что сделать (агент интерпретирует)
  deliver: DeliverTo;
  enabled: boolean;
  lastRunAt?: number; // epoch ms
}

interface SchedulesFile {
  schedules: Schedule[];
}

async function load(): Promise<SchedulesFile> {
  const f = Bun.file(schedulesPath());
  if (!(await f.exists())) return { schedules: [] };
  try {
    return { schedules: [], ...((await f.json()) as Partial<SchedulesFile>) };
  } catch {
    return { schedules: [] };
  }
}
async function save(data: SchedulesFile): Promise<void> {
  await atomicWriteJson(schedulesPath(), data);
}
function newId(existing: Schedule[]): string {
  let n = existing.length + 1;
  const ids = new Set(existing.map((s) => s.id));
  while (ids.has(`s${n}`)) n++;
  return `s${n}`;
}

export interface AddScheduleInput {
  name: string;
  everySec: number;
  instruction: string;
  deliver?: DeliverTo;
}
export async function addSchedule(input: AddScheduleInput): Promise<Schedule> {
  const data = await load();
  const s: Schedule = {
    id: newId(data.schedules),
    name: input.name,
    everySec: input.everySec,
    instruction: input.instruction,
    deliver: input.deliver ?? "bot",
    enabled: true,
  };
  data.schedules.push(s);
  await save(data);
  return s;
}
export async function listSchedules(): Promise<Schedule[]> {
  return (await load()).schedules;
}
export async function removeSchedule(id: string): Promise<boolean> {
  const data = await load();
  const before = data.schedules.length;
  data.schedules = data.schedules.filter((s) => s.id !== id);
  await save(data);
  return data.schedules.length < before;
}
export async function updateSchedule(id: string, patch: Partial<Schedule>): Promise<Schedule | null> {
  const data = await load();
  const s = data.schedules.find((x) => x.id === id);
  if (!s) return null;
  Object.assign(s, patch, { id: s.id });
  await save(data);
  return s;
}

export interface DueSchedule {
  id: string;
  name: string;
  instruction: string;
  deliver: DeliverTo;
}
/** Возвращает созревшие задачи и помечает их выполненными (lastRunAt = now). */
export async function evaluateSchedules(nowMs: number): Promise<DueSchedule[]> {
  const data = await load();
  if (data.schedules.length === 0) return [];
  const due: DueSchedule[] = [];
  let changed = false;
  for (const s of data.schedules) {
    if (!s.enabled) continue;
    if (s.lastRunAt && nowMs - s.lastRunAt < s.everySec * 1000) continue;
    s.lastRunAt = nowMs;
    changed = true;
    due.push({ id: s.id, name: s.name, instruction: s.instruction, deliver: s.deliver });
  }
  if (changed) await save(data);
  return due;
}
