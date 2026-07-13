import "./_env.ts";
import { test, expect } from "bun:test";
import { evaluatePolicy, DEFAULT_POLICY, setPolicy, getPolicy, type BotPolicy } from "../src/lib/botpolicy.ts";

const base = (over: Partial<BotPolicy> = {}): BotPolicy => ({ ...DEFAULT_POLICY, ...over });
const msg = (o: Partial<{ fromId: number; isOwner: boolean; fromIsBot: boolean; text: string }> = {}) => ({
  fromId: 1,
  isOwner: false,
  fromIsBot: false,
  text: "привет",
  ...o,
});

test("по умолчанию реагирует на людей", () => {
  expect(evaluatePolicy(msg(), base(), "b", 0, undefined).react).toBe(true);
});

test("ignoreBots: сообщение от бота пропускается", () => {
  expect(evaluatePolicy(msg({ fromIsBot: true }), base(), "b", 0, undefined).react).toBe(false);
});

test("reactTo=owner: не-владелец пропускается, владелец проходит", () => {
  expect(evaluatePolicy(msg({ isOwner: false }), base({ reactTo: "owner" }), "b", 0, undefined).react).toBe(false);
  expect(evaluatePolicy(msg({ isOwner: true }), base({ reactTo: "owner" }), "b", 0, undefined).react).toBe(true);
});

test("reactTo=список id: только указанные пользователи", () => {
  expect(evaluatePolicy(msg({ fromId: 5 }), base({ reactTo: [5] }), "b", 0, undefined).react).toBe(true);
  expect(evaluatePolicy(msg({ fromId: 6 }), base({ reactTo: [5] }), "b", 0, undefined).react).toBe(false);
});

test("ignoreUserIds: перечисленные игнорируются", () => {
  expect(evaluatePolicy(msg({ fromId: 9 }), base({ ignoreUserIds: [9] }), "b", 0, undefined).react).toBe(false);
});

test("keywordsAny: реагирует только при совпадении слова", () => {
  expect(evaluatePolicy(msg({ text: "сделай урок" }), base({ keywordsAny: ["урок"] }), "b", 0, undefined).react).toBe(true);
  expect(evaluatePolicy(msg({ text: "погода" }), base({ keywordsAny: ["урок"] }), "b", 0, undefined).react).toBe(false);
});

test("excludeKeywords: игнорирует при совпадении", () => {
  expect(evaluatePolicy(msg({ text: "спам ссылка" }), base({ excludeKeywords: ["спам"] }), "b", 0, undefined).react).toBe(false);
});

test("mentionOnly: только при @упоминании бота", () => {
  expect(evaluatePolicy(msg({ text: "эй @mybot помоги" }), base({ mentionOnly: true }), "mybot", 0, undefined).react).toBe(true);
  expect(evaluatePolicy(msg({ text: "просто текст" }), base({ mentionOnly: true }), "mybot", 0, undefined).react).toBe(false);
});

test("minIntervalSec: троттлинг по lastReactAt", () => {
  const p = base({ minIntervalSec: 60 });
  expect(evaluatePolicy(msg(), p, "b", 100_000, 80_000).react).toBe(false); // прошло 20с < 60с
  expect(evaluatePolicy(msg(), p, "b", 200_000, 80_000).react).toBe(true); // прошло 120с > 60с
});

test("setPolicy мержит и не сбрасывает поля частичным патчем", async () => {
  await setPolicy({ reactTo: "owner", keywordsAny: ["x"] });
  await setPolicy({ mentionOnly: true }); // не должно затереть reactTo/keywordsAny
  const p = await getPolicy();
  expect(p.reactTo).toBe("owner");
  expect(p.keywordsAny).toEqual(["x"]);
  expect(p.mentionOnly).toBe(true);
});
