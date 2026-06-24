// Само-обновление tg: проверка новой версии и её применение через git.
//
// Версия проекта — поле "version" в package.json; релизы помечаются git-тегами vX.Y.Z
// и описываются в CHANGELOG.md (формат Keep a Changelog). Проверка обновления:
// git fetch --tags + сравнение последнего тега с текущей версией (semver). Применение:
// git pull --ff-only + bun install. После применения сервис перезапускается (если
// запущен под менеджером — systemd/launchd — сам; иначе подскажет перезапустить вручную).

import { join } from "node:path";
import { REPO_ROOT } from "./paths.ts";

const PKG_PATH = join(REPO_ROOT, "package.json");
const CHANGELOG_PATH = join(REPO_ROOT, "CHANGELOG.md");

interface Run {
  code: number;
  out: string;
  err: string;
}
async function git(args: string[], timeoutMs = 60000): Promise<Run> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

export async function currentVersion(): Promise<string> {
  try {
    const pkg = (await Bun.file(PKG_PATH).json()) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Сравнение semver: >0 если a новее b, <0 если старее, 0 если равны. */
export function semverCompare(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [a1, a2, a3] = norm(a);
  const [b1, b2, b3] = norm(b);
  return a1! - b1! || a2! - b2! || a3! - b3!;
}

export interface UpdateCheck {
  ok: boolean;
  current: string;
  latest?: string;
  hasUpdate: boolean;
  notes?: string;
  error?: string;
}

/** Извлекает секцию CHANGELOG для версии (best-effort): «## [x.y.z] …» до следующей «## ». */
export async function changelogSection(version: string): Promise<string | undefined> {
  try {
    const text = await Bun.file(CHANGELOG_PATH).text();
    const v = version.replace(/^v/, "");
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^##\s/.test(l) && l.includes(v));
    if (start < 0) return undefined;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
    return body || undefined;
  } catch {
    return undefined;
  }
}

/** Проверяет наличие новой версии: git fetch --tags + сравнение последнего тега. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = await currentVersion();
  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) return { ok: false, current, hasUpdate: false, error: "не git-репозиторий — обновление через git недоступно" };

  const fetch = await git(["fetch", "--tags", "--quiet", "origin"]);
  if (fetch.code !== 0) return { ok: false, current, hasUpdate: false, error: `git fetch не удался: ${fetch.err || fetch.out}` };

  const tags = await git(["tag", "-l", "v*", "--sort=-v:refname"]);
  const latest = tags.out.split("\n").map((s) => s.trim()).filter(Boolean)[0];
  if (!latest) return { ok: true, current, hasUpdate: false, error: undefined };

  const hasUpdate = semverCompare(latest, current) > 0;
  const notes = hasUpdate ? await changelogSection(latest) : undefined;
  return { ok: true, current, latest: latest.replace(/^v/, ""), hasUpdate, notes };
}

export interface UpdateResult {
  ok: boolean;
  version?: string;
  output: string;
  error?: string;
}

/** Применяет обновление: git pull --ff-only + bun install. Возвращает новую версию. */
export async function applyUpdate(): Promise<UpdateResult> {
  const pull = await git(["pull", "--ff-only"]);
  if (pull.code !== 0) {
    return { ok: false, output: pull.out, error: `git pull не удался: ${pull.err || pull.out}. Возможны локальные правки — обнови вручную.` };
  }
  let installOut = "";
  try {
    const p = Bun.spawn(["bun", "install"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    installOut = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
  } catch (e) {
    installOut = e instanceof Error ? e.message : String(e);
  }
  const version = await currentVersion();
  return { ok: true, version, output: `${pull.out}\n${installOut}`.trim() };
}
