# tg — ИИ-агент личного Telegram

Этот файл — точка входа для Claude Code. **Содержательные инструкции и память
агента живут НЕ здесь, а в общей иерархии** (одинаковой для Claude Code и Codex).

## Прочитай это первым (рабочая инструкция и память)

1. Прочитай `rules/00-agent-core.md` — кто ты и доктрина «память на диске».
2. Прочитай `rules/10-memory-hierarchy.md` — структура памяти и как её вести.
3. Загрузи актуальную память: вызови MCP-инструмент `mem_bootstrap` (он соберёт
   правила + `data/handoff.md` + свежие `data/qa` + хвост `data/progress.txt`).
4. Остальные правила: `rules/20-telegram-tools.md`, `rules/30-chat-handling.md`,
   `rules/40-reply-style.md`, `rules/50-safety.md`.

## Где что менять (важно)

- **Память и личные правила меняй только в `data/`** (через `mem_*`-инструменты или
  прямым редактированием), НИКОГДА в base `rules/` и не в этом файле. Так изменения
  увидит любой следующий агент любой платформы.
- Базовые `rules/` — общий каркас в git; не редактируй их.
- Любую просьбу человека фиксируй дословно в `data/qa` (`mem_qa_record`); правила
  храни в финальном виде (`mem_rule_set`); статус — в `data/handoff.md`.

Инструменты Telegram и памяти даёт MCP-сервер `telegram` (см. `.mcp.json`). Он —
ТОНКИЙ ПРОКСИ к запущенному сервису: с Telegram работает только сервис (единственный
владелец сессии). Если инструменты возвращают «Сервис не запущен» — нужно запустить
`bun run service` (один экземпляр).

---

# Технические заметки по проекту (Bun)

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
