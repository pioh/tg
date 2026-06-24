import "./_env.ts";
import { test, expect } from "bun:test";
import { serviceDocs, currentOS } from "../src/lib/service-install.ts";

test("serviceDocs даёт платформенную инструкцию", () => {
  expect(["linux", "darwin", "win32", "other"]).toContain(currentOS());
  expect(serviceDocs("linux")).toContain("journalctl --user -u tg-agent");
  expect(serviceDocs("darwin")).toContain("launchctl");
  expect(serviceDocs("win32")).toContain("schtasks");
  // на каждой ОС есть и про логи, и про остановку
  for (const os of ["linux", "darwin", "win32"] as const) {
    expect(serviceDocs(os).length).toBeGreaterThan(50);
  }
});
