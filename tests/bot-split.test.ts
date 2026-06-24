import "./_env.ts";
import { test, expect } from "bun:test";
import { splitMessage } from "../src/lib/bot.ts";

test("короткий текст не разбивается", () => {
  expect(splitMessage("привет")).toEqual(["привет"]);
});

test("длинный текст бьётся на части ≤ 4096 с пометкой", () => {
  const text = Array.from({ length: 500 }, (_, i) => `строка ${i} ` + "x".repeat(20)).join("\n");
  const parts = splitMessage(text);
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
  expect(parts[0]!.startsWith("📄 1/")).toBe(true);
});

test("порядок сохраняется (склейка без заголовков даёт исходные строки)", () => {
  const text = Array.from({ length: 300 }, (_, i) => `L${i}`).join("\n");
  const parts = splitMessage(text);
  const joined = parts.map((p) => p.replace(/^📄 \d+\/\d+\n/, "")).join("\n");
  expect(joined).toBe(text);
});

test("очень длинная одиночная строка режется жёстко", () => {
  const parts = splitMessage("y".repeat(10000));
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
});

test("код-блок не остаётся незакрытым между частями", () => {
  const text = "```\n" + Array.from({ length: 600 }, (_, i) => `code ${i}`).join("\n") + "\n```";
  const parts = splitMessage(text);
  expect(parts.length).toBeGreaterThan(1);
  // в каждой части число ``` чётное (блок открыт-закрыт внутри части)
  for (const p of parts) {
    const fences = (p.match(/```/g) ?? []).length;
    expect(fences % 2).toBe(0);
  }
});
