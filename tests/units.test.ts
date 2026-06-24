import "./_env.ts";
import { test, expect } from "bun:test";
import { join } from "node:path";
import { normalizeEffort, isEngine, CLAUDE_EFFORTS, CODEX_EFFORTS } from "../src/lib/config.ts";
import { redact, redactToString } from "../src/lib/redact.ts";
import { atomicWrite, atomicWriteJson } from "../src/lib/atomic.ts";
import { TEST_DATA_DIR } from "./_env.ts";

test("normalizeEffort нормализует регистр и валидирует по движку", () => {
  expect(normalizeEffort("HIGH")).toBe("high");
  for (const e of CLAUDE_EFFORTS) expect(normalizeEffort(e, "claude")).toBe(e);
  for (const e of CODEX_EFFORTS) expect(normalizeEffort(e, "codex")).toBe(e);
  expect(() => normalizeEffort("turbo")).toThrow();
  // "max" — только Claude; "minimal" — только Codex.
  expect(() => normalizeEffort("max", "codex")).toThrow();
  expect(() => normalizeEffort("minimal", "claude")).toThrow();
});

test("isEngine — только claude/codex", () => {
  expect(isEngine("claude")).toBe(true);
  expect(isEngine("codex")).toBe(true);
  expect(isEngine("gpt")).toBe(false);
  expect(isEngine(undefined)).toBe(false);
});

test("redact маскирует секретные поля и токеноподобные строки", () => {
  const r = redact({ token: "abc", apiHash: "h", text: "привет", nested: { password: "p" } }) as any;
  expect(r.token).toBe("<redacted>");
  expect(r.apiHash).toBe("<redacted>");
  expect(r.nested.password).toBe("<redacted>");
  expect(r.text).toBe("привет");
  // Фейковый токеноподобный паттерн собираем в рантайме, чтобы непрерывного совпадения
  // не было в исходнике (иначе prepublish-скан примет тест за утечку).
  const fakeToken = "123456789:" + "AbCdEf".repeat(6);
  const s = redactToString({ msg: "токен " + fakeToken });
  expect(s).toContain("<redacted-token>");
});

test("atomicWrite/atomicWriteJson пишут и читаются", async () => {
  const p = join(TEST_DATA_DIR, "atomic-test.txt");
  await atomicWrite(p, "hello");
  expect(await Bun.file(p).text()).toBe("hello");
  const j = join(TEST_DATA_DIR, "atomic-test.json");
  await atomicWriteJson(j, { a: 1 });
  expect((await Bun.file(j).json()).a).toBe(1);
});
