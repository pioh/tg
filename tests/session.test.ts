import { test, expect } from "bun:test";
import { isSessionGoneError } from "../src/agent/session.ts";

test("isSessionGoneError: распознаёт удалённый транскрипт по ошибке SDK", () => {
  const err = new Error("Claude Code returned an error result: No conversation found with session ID: c729b0be-6657-496a-b38f-261e31094588");
  expect(isSessionGoneError(err)).toBe(true);
});

test("isSessionGoneError: остальные ошибки остаются падениями для watchdog", () => {
  expect(isSessionGoneError(new Error("Claude Code returned an error result: overloaded"))).toBe(false);
  expect(isSessionGoneError("No conversation found with session ID: x")).toBe(false);
  expect(isSessionGoneError(undefined)).toBe(false);
});
