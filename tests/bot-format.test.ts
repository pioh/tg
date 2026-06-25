import "./_env.ts";
import { test, expect } from "bun:test";
import { mdToTelegramHtml } from "../src/lib/bot.ts";

test("обычный текст без разметки проходит как есть", () => {
  expect(mdToTelegramHtml("привет, как дела?")).toBe("привет, как дела?");
});

test("спецсимволы HTML экранируются (< > &)", () => {
  expect(mdToTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
});

test("подчёркивания в нике НЕ ломают разметку (одиночный _ безопасен)", () => {
  // @n_e0h: одиночное подчёркивание не образует пары — остаётся буквально.
  expect(mdToTelegramHtml("пинг @n_e0h готов")).toBe("пинг @n_e0h готов");
});

test("точки/скобки в обычном тексте остаются буквальными", () => {
  const out = mdToTelegramHtml("Версия 1.2.3 (стабильная) — см. п. 4.");
  expect(out).toBe("Версия 1.2.3 (стабильная) — см. п. 4.");
});

test("жирный **...** → <b>", () => {
  expect(mdToTelegramHtml("это **важно** очень")).toBe("это <b>важно</b> очень");
});

test("жирный __...__ → <b>", () => {
  expect(mdToTelegramHtml("это __важно__ очень")).toBe("это <b>важно</b> очень");
});

test("курсив *...* → <i>", () => {
  expect(mdToTelegramHtml("чуть *наклонно* тут")).toBe("чуть <i>наклонно</i> тут");
});

test("курсив _..._ → <i>", () => {
  expect(mdToTelegramHtml("чуть _наклонно_ тут")).toBe("чуть <i>наклонно</i> тут");
});

test("зачёркнутый ~~...~~ → <s>", () => {
  expect(mdToTelegramHtml("было ~~старое~~ новое")).toBe("было <s>старое</s> новое");
});

test("инлайн-код `...` → <code>, спецсимволы внутри экранируются", () => {
  expect(mdToTelegramHtml("вызови `a < b & c`")).toBe("вызови <code>a &lt; b &amp; c</code>");
});

test("инлайн-код НЕ интерпретирует markdown внутри", () => {
  // Внутри `...` звёздочки не должны стать <b>/<i>.
  expect(mdToTelegramHtml("`x = *y* + _z_`")).toBe("<code>x = *y* + _z_</code>");
});

test("ссылка [текст](url) → <a href>", () => {
  expect(mdToTelegramHtml("см. [тут](https://t.me/foo)")).toBe(
    'см. <a href="https://t.me/foo">тут</a>',
  );
});

test("ссылка с & в url экранируется", () => {
  expect(mdToTelegramHtml("[q](https://x.io/?a=1&b=2)")).toBe(
    '<a href="https://x.io/?a=1&amp;b=2">q</a>',
  );
});

test("заголовок # → жирная строка", () => {
  expect(mdToTelegramHtml("# Заголовок\nтекст")).toBe("<b>Заголовок</b>\nтекст");
});

test("код-блок ```...``` → <pre>, язык первой строки отбрасывается", () => {
  const md = "вот код:\n```ts\nconst a = 1 < 2;\n```";
  expect(mdToTelegramHtml(md)).toBe("вот код:\n<pre>const a = 1 &lt; 2;\n</pre>");
});

test("код-блок без языка сохраняет всё содержимое", () => {
  const md = "```\nline1\nline2\n```";
  expect(mdToTelegramHtml(md)).toBe("<pre>line1\nline2\n</pre>");
});

test("markdown внутри код-блока НЕ интерпретируется", () => {
  const md = "```\n**не жирный** и @n_e0h\n```";
  expect(mdToTelegramHtml(md)).toBe("<pre>**не жирный** и @n_e0h\n</pre>");
});

test("комбинированный реальный пример (был баг B5)", () => {
  const md = "Привет, **Артемий**! Пинганул `@n_e0h` — всё ок.";
  expect(mdToTelegramHtml(md)).toBe(
    "Привет, <b>Артемий</b>! Пинганул <code>@n_e0h</code> — всё ок.",
  );
});

test("несколько строк с разной разметкой", () => {
  const md = "Список:\n- **пункт 1**\n- *пункт 2*";
  expect(mdToTelegramHtml(md)).toBe("Список:\n- <b>пункт 1</b>\n- <i>пункт 2</i>");
});

// --- Регрессы: правильная вложенность тегов и безопасные одиночные * / _ ---

test("жирный-курсив ***x*** → правильно вложенные <b><i> (не крестящиеся)", () => {
  // Раньше выходило <b><i>x</b></i> — Telegram такой HTML отвергал, всё уходило сырым.
  expect(mdToTelegramHtml("***x***")).toBe("<b><i>x</i></b>");
});

test("вложенный курсив внутри жирного на границах: **a *b* c**", () => {
  expect(mdToTelegramHtml("**a *b* c**")).toBe("<b>a <i>b</i> c</b>");
});

test("жирный с вложенным курсивом", () => {
  expect(mdToTelegramHtml("**жирный *курсив* внутри**")).toBe(
    "<b>жирный <i>курсив</i> внутри</b>",
  );
});

test("snake_case НЕ превращается в курсив (чётное число _)", () => {
  expect(mdToTelegramHtml("process_user_data")).toBe("process_user_data");
  expect(mdToTelegramHtml("my_app_server.log")).toBe("my_app_server.log");
  expect(mdToTelegramHtml("my_file_name")).toBe("my_file_name");
  expect(mdToTelegramHtml("a_b_c")).toBe("a_b_c");
});

test("умножение со звёздочками НЕ превращается в курсив", () => {
  expect(mdToTelegramHtml("цена 5*5 = 25")).toBe("цена 5*5 = 25");
  expect(mdToTelegramHtml("цена 3*4")).toBe("цена 3*4");
  expect(mdToTelegramHtml("a*b*c")).toBe("a*b*c");
});

test("курсив рядом с идентификаторами/умножением остаётся валидным", () => {
  expect(mdToTelegramHtml("цена 5*5 = 25 и ещё *курсив* тут")).toBe(
    "цена 5*5 = 25 и ещё <i>курсив</i> тут",
  );
  expect(mdToTelegramHtml("путь a_b_c и _курсив_ рядом")).toBe(
    "путь a_b_c и <i>курсив</i> рядом",
  );
});

test("одиночная _переменная_ с пробелами вокруг → курсив (намеренная разметка)", () => {
  expect(mdToTelegramHtml("переменная _count_")).toBe("переменная <i>count</i>");
});

test("незакрытый одиночный * остаётся буквальным (без висячего тега)", () => {
  expect(mdToTelegramHtml("незакрытый *курсив без пары")).toBe(
    "незакрытый *курсив без пары",
  );
});
