import "./_env.ts";
import { test, expect } from "bun:test";
import { mergeRules, setRule, recordQa, readRecentQa, appendProgress, readProgressTail } from "../src/lib/memory.ts";

test("data/rules переопределяет базовое правило по имени, кастомные добавляются", async () => {
  await setRule("50-safety", "ЛИЧНЫЙ ОВЕРРАЙД");
  await setRule("99-custom", "КАСТОМНОЕ ПРАВИЛО");
  const rules = await mergeRules();
  const override = rules.find((r) => r.name === "50-safety.md");
  expect(override?.source).toBe("override");
  expect(override?.content).toContain("ЛИЧНЫЙ ОВЕРРАЙД");
  const custom = rules.find((r) => r.name === "99-custom.md");
  expect(custom?.source).toBe("custom");
  // базовые правила без оверрайда остаются базовыми
  expect(rules.some((r) => r.source === "base")).toBe(true);
});

test("setRule защищён от path traversal (basename)", async () => {
  const path = await setRule("../evil", "x");
  expect(path).not.toContain("..");
  expect(path.endsWith("evil.md")).toBe(true);
});

test("qa и progress дописываются (append-only)", async () => {
  await recordQa("первая просьба", "test");
  await recordQa("вторая просьба", "test");
  const qa = await readRecentQa(1);
  expect(qa).toContain("первая просьба");
  expect(qa).toContain("вторая просьба");

  await appendProgress("сделал X");
  const tail = await readProgressTail(10);
  expect(tail).toContain("сделал X");
});
