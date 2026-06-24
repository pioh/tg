import "./_env.ts";
import { test, expect } from "bun:test";
import { join } from "node:path";
import { normalizeEffort, isEngine, EFFORT_LEVELS } from "../src/lib/config.ts";
import { redact, redactToString } from "../src/lib/redact.ts";
import { atomicWrite, atomicWriteJson } from "../src/lib/atomic.ts";
import { TEST_DATA_DIR } from "./_env.ts";

test("normalizeEffort нормализует регистр и валидирует", () => {
  expect(normalizeEffort("HIGH")).toBe("high");
  for (const e of EFFORT_LEVELS) expect(normalizeEffort(e)).toBe(e);
  expect(() => normalizeEffort("turbo")).toThrow();
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
