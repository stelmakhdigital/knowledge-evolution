import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { MockHarnessProposer, validateProposals, insertProposals } from "../src/llm/proposer.js";
import { collectSignals, runProposer } from "../src/meta/proposer.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);

describe("валидация LLM-предложений (M6.2, harness.md §9)", () => {
  it("whitelist, границы, no-change, дубли, rationale-минимум", () => {
    const report = validateProposals(
      [
        { field: "items.max_length", newValue: "1000", rationale: "поле вне whitelist" },
        { field: "theta_score", newValue: "0.99", rationale: "сверх границ (макс 0.9)" },
        { field: "theta_score", newValue: String(CONFIG.theta_score), rationale: "без изменения" },
        { field: "ablation.negative", newValue: "false", rationale: "неделя без negative-инъекций" },
        { field: "retrieval.top_k", newValue: "4", rationale: "сужаем выдачу" },
        { field: "retrieval.top_k", newValue: "4", rationale: "дубликат в прогоне" },
        { field: "theta_dedup", newValue: "0.9", rationale: "коротко" },
      ],
      CONFIG,
    );
    const fields = report.accepted.map((p) => p.field).sort();
    expect(fields).toEqual(["ablation.negative", "retrieval.top_k"]);
    const rejectedFields = report.rejected.map((r) => r.field).sort();
    expect(rejectedFields).toEqual(
      ["items.max_length", "retrieval.top_k", "theta_dedup", "theta_score", "theta_score"].sort(),
    );
    const reasons = report.rejected.map((r) => r.reason);
    expect(reasons.some((r) => r.includes("whitelist"))).toBe(true);
    expect(reasons.some((r) => r.includes("границ"))).toBe(true);
    expect(reasons.some((r) => r.includes("нет изменения"))).toBe(true);
    expect(report.accepted.find((p) => p.field === "ablation.negative")?.evidence["proposer"]).toBe("llm");
  });
});

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const LLM_META_DB_URL = process.env["EVOLVE_LLM_META_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_llm_meta_test";

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

async function freshDb(url: string, dbName: string): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dir = path.join(root, "db", "migrations");
    const client = await pool.connect();
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
        await client.query("BEGIN");
        await client.query(readFileSync(path.join(dir, f), "utf8"));
        await client.query("COMMIT");
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

describe.skipIf(!pgAvailable)("LLM-пропонер: полный прогон (M6.2)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await freshDb(LLM_META_DB_URL, "evolve_llm_meta_test");
    pool = new Pool({ connectionString: LLM_META_DB_URL, max: 2 });
    // 2 активных предложения: запускает mock-сигнал top_k (proposalsActive >= 2)
    for (const field of ["degradation.unused_days", "canary.window_days"]) {
      await pool.query(
        `INSERT INTO proposals (id, target, field, old_value, new_value, rationale, status)
         VALUES ($1, 'seed', $2, '21', '28', 'seed-предложение', 'proposed')`,
        [randomUUID(), field],
      );
    }
    // dedup-шум: 12 результатов, 4 pass → pass rate 33%
    for (let i = 0; i < 12; i++) {
      await pool.query(
        `INSERT INTO gate_results (id, candidate_id, gate, result, detail, created_at)
         VALUES ($1, 'cand-llm', 'dedup', CASE WHEN $2 <= 4 THEN 'pass' ELSE 'fail' END, '{}'::jsonb, now() - ($2 * interval '1 hour'))`,
        [randomUUID(), i + 1],
      );
    }
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  it("правила + LLM в одну очередь: дубликаты схлопываются, невалидные — нет", async () => {
    // M6.1-правила: theta_dedup 0.85 → 0.90
    const rules = await runProposer(pool, CONFIG, new Date());
    expect(rules.created.map((p) => p.field)).toContain("theta_dedup");

    // M6.2-LLM поверх тех же сигналов
    const proposer = new MockHarnessProposer();
    const signals = await collectSignals(pool, CONFIG, new Date());
    expect(signals.proposalsActive).toBeGreaterThanOrEqual(2);
    const raw = await proposer.propose({
      telemetry: signals,
      config: CONFIG as unknown as Record<string, unknown>,
      harnessDoc: "harness.md (test stub)",
    });
    const report = validateProposals(raw, CONFIG);
    expect(report.rejected.map((r) => r.field).sort()).toEqual(
      ["items.max_length", "theta_score"].sort(),
    );
    const inserted = await insertProposals(pool, report.accepted, "harness.md (llm, M6.2)");
    // mock даёт theta_dedup 0.9 (дубль правила — skipped) и top_k 4 (новый)
    expect(inserted.created).toBe(1);
    expect(inserted.skippedDuplicates).toBe(1);

    // очередь: theta_dedup ровно 1 строка, top_k — 1, невалидных полей нет
    const theta = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE field = 'theta_dedup'`);
    expect(Number(theta.rows[0]["n"])).toBe(1);
    const topk = await pool.query(`SELECT new_value FROM proposals WHERE field = 'retrieval.top_k'`);
    expect(topk.rows).toHaveLength(1);
    expect(String(topk.rows[0]["new_value"])).toBe("4");
    const bad = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE field = 'items.max_length'`);
    expect(Number(bad.rows[0]["n"])).toBe(0);
  });
});
