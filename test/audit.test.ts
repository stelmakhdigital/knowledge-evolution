import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditAgentAgnostic } from "../src/audit/agent-agnostic.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const AUDIT_DB_URL = process.env["EVOLVE_AUDIT_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_audit_test";

const pgAvailable = await (async (): Promise<boolean> => {
  try {
    const pool = new Pool({ connectionString: ADMIN_URL, max: 1 });
    const ok = (await pool.query("SELECT 1")).rows.length === 1;
    await pool.end();
    return ok;
  } catch {
    return false;
  }
})();

describe("agent-agnostic audit (ТЗ §14)", () => {
  it("статические проверки: весь конвейер без хардкода агентов", async () => {
    const checks = await auditAgentAgnostic(ROOT);
    const byId = new Map(checks.map((c) => [c.id, c]));
    for (const id of [
      "no-hardcoded-agents",
      "applies-to-default",
      "retrieval-filters-applies-to",
      "score-per-pair",
      "agent-profiles",
    ] as const) {
      expect(byId.get(id)?.ok, `${id}: ${byId.get(id)?.detail}`).toBe(true);
    }
    // без БД 6-я проверка не выполняется
    expect(checks.find((c) => c.id === "applies-to-values")).toBeUndefined();
  });

  it("нарушение обнаруживается: литерал агента в конвейере", async () => {
    // временно «загрязняем» конвейерный файл и убеждаемся, что аудит падает
    const target = path.join(ROOT, "src", "decay", "decay.ts");
    const original = readFileSync(target, "utf8");
    const fs = await import("node:fs");
    try {
      fs.writeFileSync(target, `${original}\n// загран: const x: "dsh" = "dsh";\n`);
      const checks = await auditAgentAgnostic(ROOT);
      const bad = checks.find((c) => c.id === "no-hardcoded-agents");
      expect(bad?.ok).toBe(false);
      expect(bad?.detail).toMatch(/decay\.ts/);
    } finally {
      fs.writeFileSync(target, original);
    }
  });
});

describe.skipIf(!pgAvailable)("agent-agnostic audit: живая БД (M5.1)", () => {
  let pool: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
    await admin.query(`DROP DATABASE IF EXISTS evolve_audit_test WITH (FORCE)`);
    await admin.query(`CREATE DATABASE evolve_audit_test`);
    await admin.end();
    pool = new Pool({ connectionString: AUDIT_DB_URL, max: 2 });
    const dir = path.join(ROOT, "db", "migrations");
    const client = await pool.connect();
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
        await client.query(readFileSync(path.join(dir, f), "utf8"));
      }
    } finally {
      client.release();
    }
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  it("все 6 проверок, включая PK и applies_to-значения", async () => {
    const checks = await auditAgentAgnostic(ROOT, pool);
    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(checks).toHaveLength(6);
    for (const c of checks) {
      expect(c.ok, `${c.id}: ${c.detail}`).toBe(true);
    }
    expect(byId.get("score-per-pair")?.detail).toMatch(/живая БД/);
    // пустая БД: applies_to — только 'all' по умолчанию
    const res = await pool.query(`SELECT count(*)::int AS n FROM items WHERE applies_to <> 'all'`);
    expect(Number(res.rows[0]["n"])).toBe(0);
  });
});
