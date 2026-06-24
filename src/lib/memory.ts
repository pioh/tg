// Дисковая память агента — единственная память, которая переживает сессии.
//
// Доктрина (см. rules/00-agent-core.md): сессий много, контекст модели обнуляется,
// поэтому ВСЁ значимое живёт на диске в data/ и читается в начале каждой сессии.
//
// Структура памяти:
//   data/handoff.md     — АКТУАЛЬНЫЙ статус «здесь и сейчас». Перезаписывается.
//   data/progress.txt   — APPEND-ONLY журнал значимых действий. Только дописываем.
//   data/qa/<date>.md   — ДОСЛОВНЫЕ просьбы человека. Только дописываем.
//   rules/ + data/rules — правила (база в git + личные оверрайды по имени файла).
//   data/memory/*.md    — долговременная структурированная память.

import { appendFile, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  botChatPath,
  dataDir,
  dataRulesDir,
  downloadsDir,
  handoffPath,
  memoryDir,
  progressPath,
  qaDir,
  REPO_ROOT,
  RULES_DIR,
  sessionDir,
} from "./paths.ts";

// ---------- утилиты дат ----------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function stamp(): string {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
async function readText(p: string): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}

// ---------- инициализация структуры data/ ----------

const HANDOFF_SEED = `# Handoff — актуальный статус

> Этот файл читает каждый следующий агент ПЕРВЫМ делом. Здесь всегда лежит
> текущее состояние: над чем работаем, что в ожидании, что только что сделано,
> какие открытые вопросы. Держите его коротким и актуальным — перезаписывайте,
> а не накапливайте историю (история — в data/progress.txt).

## Сейчас
- Проект только что инициализирован. Активных задач нет.

## В ожидании
- (пусто)

## Открытые вопросы к человеку
- (пусто)
`;

const PROGRESS_SEED = `# progress.txt — append-only журнал значимых действий.
# Каждый агент дописывает строки В КОНЕЦ. Не редактировать и не переписывать.
# Формат: YYYY-MM-DD HH:MM:SS  <что сделано>
`;

/** Создаёт все нужные папки и засевает базовые файлы, если их ещё нет. */
export async function ensureDataLayout(): Promise<void> {
  for (const d of [dataDir(), dataRulesDir(), sessionDir(), qaDir(), memoryDir(), downloadsDir()]) {
    await mkdir(d, { recursive: true });
  }
  if (!(await exists(handoffPath()))) await Bun.write(handoffPath(), HANDOFF_SEED);
  if (!(await exists(progressPath()))) await Bun.write(progressPath(), PROGRESS_SEED);
}

// ---------- handoff ----------

export async function readHandoff(): Promise<string> {
  return readText(handoffPath());
}
export async function writeHandoff(content: string): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await Bun.write(handoffPath(), content.endsWith("\n") ? content : content + "\n");
}

// ---------- progress ----------

// Засев заголовка строго один раз через АТОМАРНЫЙ эксклюзивный open("ax")
// (O_CREAT|O_EXCL), затем — безусловная дозапись. Так нет ни усечения, ни дубля
// заголовка при гонке параллельных вызовов (append-only лог не теряет строк).
// Важно: в Bun appendFile с флагом "ax" НЕ эксклюзивен, поэтому используем open().
async function seedOnce(path: string, seed: string): Promise<void> {
  let fh;
  try {
    fh = await open(path, "ax");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return;
    throw e;
  }
  try {
    await fh.writeFile(seed);
  } finally {
    await fh.close();
  }
}

export async function appendProgress(line: string): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await seedOnce(progressPath(), PROGRESS_SEED);
  const clean = line.replace(/\s+/g, " ").trim();
  await appendFile(progressPath(), `${stamp()}  ${clean}\n`, "utf8");
}

export async function readProgressTail(lines = 40): Promise<string> {
  const all = (await readText(progressPath())).split("\n").filter((l) => l.length > 0);
  return all.slice(-lines).join("\n");
}

// ---------- QA (дословные просьбы человека) ----------

/**
 * Дословно фиксирует просьбу человека в data/qa/<сегодня>.md.
 * source — откуда пришла просьба (например "telegram:me", "cli", "claude-code").
 */
export async function recordQa(text: string, source = "unknown"): Promise<string> {
  await mkdir(qaDir(), { recursive: true });
  const file = join(qaDir(), `${today()}.md`);
  await seedOnce(file, `# Просьбы человека — ${today()}\n\n`);
  const entry = `## ${stamp()} · ${source}\n\n${text.trim()}\n\n`;
  await appendFile(file, entry, "utf8");
  return file;
}

/** Возвращает содержимое QA за последние n дней (включая сегодня). */
export async function readRecentQa(days = 3): Promise<string> {
  if (!(await exists(qaDir()))) return "";
  const files = (await readdir(qaDir()))
    .filter((f) => f.endsWith(".md"))
    .sort();
  const recent = files.slice(-days);
  const parts: string[] = [];
  for (const f of recent) {
    parts.push(`----- ${f} -----\n${await readText(join(qaDir(), f))}`);
  }
  return parts.join("\n\n");
}

// ---------- правила: rules/ + data/rules (оверрайд по имени) ----------

export interface MergedRule {
  name: string;
  source: "base" | "override" | "custom";
  content: string;
}

async function listMd(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
}

/**
 * Сливает базовые правила (rules/) с пользовательскими (data/rules/):
 *  - файл в data/rules с тем же именем ПОЛНОСТЬЮ заменяет базовый;
 *  - файлы из data/rules без базового аналога добавляются как кастомные.
 * Порядок — по имени файла (используйте префиксы 00-, 10-, ... для сортировки).
 */
export async function mergeRules(): Promise<MergedRule[]> {
  const baseFiles = await listMd(RULES_DIR);
  const overrideFiles = new Set(await listMd(dataRulesDir()));
  const result: MergedRule[] = [];

  for (const name of baseFiles) {
    if (overrideFiles.has(name)) {
      result.push({ name, source: "override", content: await readText(join(dataRulesDir(), name)) });
      overrideFiles.delete(name);
    } else {
      result.push({ name, source: "base", content: await readText(join(RULES_DIR, name)) });
    }
  }
  // оставшиеся файлы data/rules — чистые добавления
  for (const name of [...overrideFiles].sort()) {
    result.push({ name, source: "custom", content: await readText(join(dataRulesDir(), name)) });
  }
  // Финальная сортировка по имени файла, чтобы кастомные правила (напр. 25-*.md)
  // вставали между базовыми (20-, 30-), как обещает контракт числовых префиксов.
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export async function mergedRulesText(): Promise<string> {
  const rules = await mergeRules();
  if (rules.length === 0) return "(правил пока нет)";
  return rules
    .map((r) => `<!-- ${r.name} · источник: ${r.source} -->\n${r.content.trim()}`)
    .join("\n\n---\n\n");
}

/** Записывает/переопределяет правило в data/rules/<name>. Базу в rules/ не трогаем. */
export async function setRule(name: string, content: string): Promise<string> {
  await mkdir(dataRulesDir(), { recursive: true });
  const safe = basename(name).endsWith(".md") ? basename(name) : `${basename(name)}.md`;
  const path = join(dataRulesDir(), safe);
  await Bun.write(path, content.endsWith("\n") ? content : content + "\n");
  return path;
}

// ---------- долговременная память ----------

export async function setMemory(name: string, content: string): Promise<string> {
  await mkdir(memoryDir(), { recursive: true });
  const safe = basename(name).endsWith(".md") ? basename(name) : `${basename(name)}.md`;
  const path = join(memoryDir(), safe);
  await Bun.write(path, content.endsWith("\n") ? content : content + "\n");
  return path;
}

/** Полный текст одной заметки памяти по имени (basename защищает от traversal). */
export async function getMemory(name: string): Promise<string | null> {
  const safe = basename(name).endsWith(".md") ? basename(name) : `${basename(name)}.md`;
  const path = join(memoryDir(), safe);
  if (!(await exists(path))) return null;
  return readText(path);
}

/** Поиск по всем заметкам памяти: возвращает имя + краткий фрагмент с совпадением. */
export async function searchMemory(query: string): Promise<{ name: string; snippet: string }[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const files = await listMd(memoryDir());
  const hits: { name: string; snippet: string }[] = [];
  for (const f of files) {
    const txt = await readText(join(memoryDir(), f));
    const idx = txt.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      hits.push({ name: f, snippet: txt.slice(start, idx + q.length + 60).replace(/\s+/g, " ").trim() });
    }
  }
  return hits;
}

/** Краткий индекс файлов памяти: имя + первая содержательная строка. */
export async function memoryIndex(): Promise<string> {
  const files = await listMd(memoryDir());
  if (files.length === 0) return "(память пуста)";
  const parts: string[] = [];
  for (const f of files) {
    const txt = await readText(join(memoryDir(), f));
    const firstLine = txt.split("\n").find((l) => l.trim().length > 0) ?? "";
    parts.push(`- ${f}: ${firstLine.replace(/^#+\s*/, "").slice(0, 100)}`);
  }
  return parts.join("\n");
}

// ---------- переписка с ботом (на диске) ----------

/** Хвост переписки человека с сервисным ботом — чтобы другие агенты видели контекст. */
export async function readBotChatTail(lines = 80): Promise<string> {
  const all = (await readText(botChatPath())).split("\n");
  return all.slice(-lines).join("\n").trim();
}

// ---------- сборка единого контекста для агента ----------

const DOCTRINE = `ДОКТРИНА ПАМЯТИ (обязательно к исполнению):
Ты — постоянный ИИ-агент личного Telegram. Сессий будет много, контекст модели
между ними обнуляется. Твоя ЕДИНСТВЕННАЯ память — файлы в data/ на диске.
- В начале каждой сессии прочитай память (этот контекст уже её содержит).
- Все правила храни в ФИНАЛЬНОМ виде, как человек хочет В ИТОГЕ (а не как было
  изначально). Личные правила пиши в data/rules/ (оверрайд по имени файла),
  базовые rules/ из git не редактируй.
- Все просьбы человека фиксируй ДОСЛОВНО в data/qa/<дата>.md (инструмент qa_record
  или tg_control_poll делает это сам).
- Значимые действия дописывай в data/progress.txt (progress_append).
- Поддерживай data/handoff.md в актуальном состоянии (handoff_set) — его читает
  следующий агент.
- Память едина для всех платформ (Claude Code, Codex): меняй её только в data/,
  через эти инструменты/файлы, чтобы любой следующий агент любой платформы её увидел.`;

export interface AssembledContext {
  doctrine: string;
  rules: string;
  handoff: string;
  recentQa: string;
  progressTail: string;
  memory: string;
  botChat: string;
}

export async function assembleContext(): Promise<AssembledContext> {
  return {
    doctrine: DOCTRINE,
    rules: await mergedRulesText(),
    handoff: (await readHandoff()) || "(handoff пуст)",
    recentQa: (await readRecentQa(3)) || "(свежих просьб нет)",
    progressTail: (await readProgressTail(40)) || "(журнал пуст)",
    memory: await memoryIndex(),
    botChat: (await readBotChatTail(80)) || "(переписки с ботом пока нет)",
  };
}

/** Текущая версия проекта (для само-миграции агентом — см. rules/15-updates.md). */
async function tgVersion(): Promise<string> {
  try {
    const pkg = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "неизвестна";
  }
}

/** Тот же контекст одной строкой markdown — для system-prompt / bootstrap. */
export async function assembleContextText(): Promise<string> {
  const c = await assembleContext();
  return [
    `# ВЕРСИЯ tg: ${await tgVersion()}  (если новее прежней и формат изменился — см. rules/15-updates.md и мигрируй)`,
    c.doctrine,
    `# ПРАВИЛА (rules/ + data/rules)\n\n${c.rules}`,
    `# ТЕКУЩИЙ СТАТУС (data/handoff.md)\n\n${c.handoff}`,
    `# СВЕЖИЕ ДОСЛОВНЫЕ ПРОСЬБЫ (data/qa)\n\n${c.recentQa}`,
    `# ПОСЛЕДНЯЯ ПЕРЕПИСКА С БОТОМ (хвост data/bot-chat.md)\n\n${c.botChat}`,
    `# ЖУРНАЛ ПОСЛЕДНИХ ДЕЙСТВИЙ (хвост data/progress.txt)\n\n${c.progressTail}`,
    `# ИНДЕКС ДОЛГОВРЕМЕННОЙ ПАМЯТИ (data/memory)\n\n${c.memory}`,
  ].join("\n\n========================================\n\n");
}
