// Изолируем тесты от реальной data/: подменяем TG_DATA_DIR на временную папку ДО
// импорта модулей, читающих пути (paths.ts вычисляет DATA_DIR при импорте). Поэтому
// этот файл импортируется ПЕРВЫМ в каждом тесте.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_DATA_DIR: string = mkdtempSync(join(tmpdir(), "tg-test-"));
process.env.TG_DATA_DIR = TEST_DATA_DIR;
// И корень тенантов — во временную папку (мультитенант-тесты не трогают реальные tenants/).
process.env.TG_TENANTS_DIR = join(TEST_DATA_DIR, "tenants");
