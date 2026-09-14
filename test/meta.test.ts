import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { decideProposal, listProposals, runProposer } from "../src/meta/proposer.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);

const ADMIN_URL = process.env?.["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const META_DB_URL = process.env?.["EVOLVE_META_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_meta_test";

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

describe.skipIf(!pgAvailable)("meta proposer (ТЗ §15/M6.1, harness.md §9)", () => {
  let pool: Pool;

  const IT_META = "00000000-0000-0000-0000-0000000000aa";

  beforeAll(async () => {
    await freshDb(META_DB_URL, "evolve_meta_test");
    pool = new Pool({ connectionString: META_DB_URL, max: 2 });
    // заглушка item для FK usage_log/decisions
    await pool.query(
      `INSERT INTO items (id, type, title, scope, tags, applies_to, status, risk_tier, version, body, body_hash, score_global, created_at, updated_at)
       VALUES ($1, 'fact', 'мета-заглушка', 'all', '{}', 'all', 'active', 'low', 1, 'тело заглушки', 'sha256:meta', 0.5, now() - interval '3 days', now())`,
      [IT_META],
    );
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  it("пустая база — предложений нет", async () => {
    const res = await runProposer(pool, CONFIG, new Date());
    expect(res.created).toHaveLength(0);
  });

  it("S1: дедуп-шум → поднять θ_dedup; идемпотентность повторного прогона", async () => {
    // 12 gate-результатов dedup за 30 дней: 4 pass, 8 fail → pass rate 33% < 50%
    for (let i = 0; i < 12; i++) {
      await pool.query(
        `INSERT INTO gate_results (id, candidate_id, gate, result, detail, created_at)
         VALUES ($1, 'cand-meta', 'dedup', CASE WHEN $2 <= 4 THEN 'pass' ELSE 'fail' END, '{}'::jsonb, now() - ($2 * interval '1 hour'))`,
        [randomUUID(), i + 1],
      );
    }
    const res = await runProposer(pool, CONFIG, new Date());
    const theta = res.created.find((p) => p.field === "theta_dedup");
    expect(theta, `создано: ${res.created.map((p) => p.field).join(", ")}`).toBeDefined();
    expect(theta?.oldValue).toBe(String(CONFIG.theta_dedup));
    expect(Number(theta?.newValue)).toBeCloseTo(Number((CONFIG.theta_dedup + 0.05).toFixed(2)), 5);
    expect(Number(theta?.evidence?.["dedup_pass_rate"])).toBeCloseTo(4 / 12, 4);

    // повторный прогон: то же предложение — дубликат, не создаётся
    const again = await runProposer(pool, CONFIG, new Date());
    expect(again.created.find((p) => p.field === "theta_dedup")).toBeUndefined();
    expect(again.skippedDuplicates).toBeGreaterThanOrEqual(1);
  });

  it("S3: success-rate агента ниже baseline → ablation.negative-эксперимент", async () => {
    // агент 'dsh': 10 verdicts, 2 success (sr 0.2); agent 'other': 10 verdicts, 8 success (sr 0.8)
    // baseline = 10/20 = 0.5 → dsh (0.2) < 0.5 − 0.1
    for (let i = 0; i < 10; i++) {
      await pool.query(
        `INSERT INTO usage_log (item_id, version, agent_id, task_id, task_success, retrieved_at)
         VALUES ($1, 1, 'dsh', $2, CASE WHEN $3 <= 2 THEN true ELSE false END, now() - ($3 * interval '1 hour'))`,
        [IT_META, `task-d-${i}`, i + 1],
      );
      await pool.query(
        `INSERT INTO usage_log (item_id, version, agent_id, task_id, task_success, retrieved_at)
         VALUES ($1, 1, 'other', $2, CASE WHEN $3 <= 8 THEN true ELSE false END, now() - ($3 * interval '1 hour'))`,
        [IT_META, `task-o-${i}`, i + 1],
      );
    }
    const res = await runProposer(pool, CONFIG, new Date());
    const abl = res.created.find((p) => p.field === "ablation.negative");
    expect(abl, `создано: ${res.created.map((p) => p.field).join(", ")}`).toBeDefined();
    expect(abl?.oldValue).toBe("true");
    expect(abl?.newValue).toBe("false");
    expect(abl?.evidence?.["agent"]).toBe("dsh");
    expect(abl?.evidence?.["success_rate"]).toBeCloseTo(0.2, 5);
  });

  it("S4: canary demote-доля ≥ 30% → min_retrievals выше", async () => {
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO decisions (id, item_id, version, kind, actor, reason, evidence, created_at)
         VALUES ($1, $2, 1, 'demote', 'auto:canary', 'canary fail', '{}'::jsonb, now() - ($3 * interval '1 day'))`,
        [randomUUID(), IT_META, i + 1],
      );
    }
    await pool.query(
      `INSERT INTO decisions (id, item_id, version, kind, actor, reason, evidence, created_at)
       VALUES ($1, $2, 1, 'promote', 'auto:canary', 'canary pass', '{}'::jsonb, now() - interval '2 days')`,
      [randomUUID(), IT_META],
    );
    const res = await runProposer(pool, CONFIG, new Date());
    const can = res.created.find((p) => p.field === "canary.min_retrievals");
    expect(can, `создано: ${res.created.map((p) => p.field).join(", ")}`).toBeDefined();
    expect(Number(can?.newValue)).toBe(CONFIG.canary.min_retrievals + 1);
  });

  it("очередь и решения человека: apply/reject, повторное решение — ошибка", async () => {
    const res = await runProposer(pool, CONFIG, new Date());
    // в очереди точно есть что-то proposed
    const rows = await listProposals(pool, "proposed");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const first = rows[0];
    void res;

    const applied = await decideProposal(pool, first?.["id"] as string, "applied", "human:dev", "golden-отчёт: +6 п.п.", new Date());
    expect(applied).not.toBeNull();
    expect(applied?.["status"]).toBe("applied");
    expect(applied?.["decided_by"]).toBe("human:dev");

    const rejected = await decideProposal(pool, rows[1]["id"] as string, "rejected", "human:dev", "нет данных", new Date());
    expect(rejected?.["status"]).toBe("rejected");

    // повторное решение того же id — null (уже решено)
    const again = await decideProposal(pool, first?.["id"] as string, "rejected", "human:dev", "", new Date());
    expect(again).toBeNull();

    const appliedRows = await listProposals(pool, "applied");
    expect(appliedRows).toHaveLength(1);
  });
});
