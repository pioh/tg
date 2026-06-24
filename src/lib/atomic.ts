// Атомарная запись файлов: пишем во временный файл рядом, затем rename().
// rename в пределах одной ФС атомарен — при падении питания/процесса на диске
// останется либо старая, либо новая полная версия, но НИКОГДА не пустой/обрезанный
// файл. Это важно для state/config/monitors/schedules/permissions: иначе можно
// проснуться с `monitors.json = ""` и потерять все настройки.

import { rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

let counter = 0;

/** Атомарно записать текст в path (через временный файл + rename). */
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Уникальность без Math.random/Date.now (могут быть недоступны): pid + счётчик.
  const tmp = `${path}.tmp-${process.pid}-${counter++}`;
  await Bun.write(tmp, content);
  await rename(tmp, path);
}

/** Атомарно записать объект как форматированный JSON (с финальным переводом строки). */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await atomicWrite(path, JSON.stringify(data, null, 2) + "\n");
}
