import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { latestCriticWeight, recomputeCriticWeight } from "../src/critic/critic.js";
import { MockLlm } from "../src/llm/client.js";
import { buildWeeklyReport, renderMarkdown } from "../src/report/report.js";
import { recordReview } from "../src/review/review.js";
import { PgStore } from "../src/store/pg-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const CRITIC_DB_URL = process.env["EVOLVE_CRITIC_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_critic_test";

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
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const applied = new Set((await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r["name"] as string));
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
        if (applied.has(f)) {
          continue;
        }
        await client.query("BEGIN");
        await client.query(readFileSync(path.join(dir, f), "utf8"));
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
        await client.query("COMMIT");
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

describe.skipIf(!pgAvailable)("авто-вес критика на живом PG (M4.2)", () => {
  let store: PgStore;

  beforeAll(async () => {
    await freshDb(CRITIC_DB_URL, "evolve_critic_test");
    store = new PgStore({ connectionString: CRITIC_DB_URL, clock: () => new Date(NOW) });
  }, 60_000);
  afterAll(async () => {
    await store.close();
  });

  it("пустая база: вес = базовый, без сигналов", async () => {
    const stats = await recomputeCriticWeight(store, CONFIG, NOW);
    expect(stats.lessons).toBe(0);
    expect(stats.gatePassRate).toBeNull();
    expect(stats.weight).toBe(CONFIG.critic.weight);
    expect(await latestCriticWeight(store.pool)).toBe(CONFIG.critic.weight);
  });

  it("gate-pass: 5/6 lesson прошли (6-й — дневной лимит G5) → вес снижается", async () => {
    for (let i = 0; i < 6; i += 1) {
      await recordReview(
        store,
        CONFIG,
        {
          taskId: `task-c-${i}`,
          source: "critic",
          agentId: "dsh",
          rating: 2,
          transcriptHash: `sha256:c${i}`,
          commit: "cafe",
          issues: [
            { type: "bug", severity: "med", evidence: `f.ts:${i}`, lessonCandidate: `lesson критика номер ${i}` },
          ],
          llm: new MockLlm(),
        },
        NOW,
      );
    }
    const stats = await recomputeCriticWeight(store, CONFIG, NOW);
    expect(stats.lessons).toBe(6);
    expect(stats.accepted).toBe(5);
    expect(stats.gatePassRate).toBeCloseTo(5 / 6, 5);
    expect(stats.usageFactor).toBe(1); // нет вердиктов
    expect(stats.weight).toBeCloseTo(CONFIG.critic.weight * (0.5 + 0.5 * (5 / 6)), 5);
  });

  it("usage-фактор: critic_sr против baseline (clamp 0.5..1.5)", async () => {
    // 5 lesson-элементов критика: берём первый принятый — кладём 6 вердиктов (5 success)
    const items = (
      await store.pool.query(`SELECT i.id FROM items i JOIN provenance p ON p.item_id = i.id
                              WHERE p.source_type = 'critic' ORDER BY i.created_at LIMIT 1`)
    ).rows;
    const criticItem = items[0]["id"] as string;
    for (let i = 0; i < 6; i += 1) {
      await store.addUsage({
        id: randomUUID(),
        itemId: criticItem,
        version: 1,
        agentId: "dsh",
        taskId: `t-cu-${i}`,
        taskSuccess: i < 5 ? true : false,
        retrievedAt: NOW.toISOString(),
      });
    }
    // «чужая» база: non-critic item с 4 success → baseline 9/10 = 0.9 > critic_sr
    const otherId = randomUUID();
    const start = new Date(NOW.getTime() - 5 * 86_400_000);
    await store.addItem({
      item: {
        id: otherId, type: "fact", title: "не-критиковый элемент", scope: "all", tags: [],
        appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body: "чужое знание",
        bodyHash: (await import("../src/domain/hashing.js")).hashBody("чужое знание"),
        embeddingId: null, scoreGlobal: 0,
        createdAt: start.toISOString(), updatedAt: start.toISOString(),
      },
      provenance: [
        { sourceType: "human", taskId: "seed-other", transcriptHash: "sha256:o", commit: "seed", payload: {}, createdAt: start.toISOString() },
      ],
      initialDecision: { itemId: otherId, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
    });
    await store.applyTransition(otherId, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    await store.applyTransition(otherId, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
    for (let i = 0; i < 4; i += 1) {
      await store.addUsage({
        id: randomUUID(),
        itemId: otherId,
        version: 1,
        agentId: "dsh",
        taskId: `t-oth-${i}`,
        taskSuccess: true,
        retrievedAt: NOW.toISOString(),
      });
    }
    const stats = await recomputeCriticWeight(store, CONFIG, NOW);
    // critic_sr = 5/6, baseline = 9/10 → ratio 0.9259 → usage_factor 0.9259
    expect(stats.criticVerdicts).toBe(6);
    expect(stats.criticSuccessRate).toBeCloseTo(5 / 6, 5);
    expect(stats.baselineSuccessRate).toBeCloseTo(0.9, 5);
    expect(stats.usageFactor).toBeCloseTo((5 / 6) / 0.9, 5);
    expect(stats.weight).toBeCloseTo(
      CONFIG.critic.weight * (0.5 + 0.5 * (5 / 6)) * (5 / 6) / 0.9,
      5,
    );
  });

  it("идемпотентность: повторный пересчёт — тот же вес, previousWeight задан", async () => {
    const a = await recomputeCriticWeight(store, CONFIG, NOW);
    expect(a.weight).toBeCloseTo(CONFIG.critic.weight * (0.5 + 0.5 * (5 / 6)) * (5 / 6) / 0.9, 5);
    const b = await recomputeCriticWeight(store, CONFIG, NOW);
    expect(b.weight).toBe(a.weight);
    expect(b.previousWeight).toBeCloseTo(a.weight, 5); // PG real (float4) — 8 цифр
    const rows = await store.pool.query(`SELECT count(*)::int AS n FROM critic_weights`);
    expect(Number(rows.rows[0]["n"])).toBe(1);
  });

  it("отчёт: секция критика видна (ТЗ §15 M4 «вес-механика видна в отчёте»)", async () => {
    const report = await buildWeeklyReport(store.pool, CONFIG, NOW);
    expect(report.critic).not.toBeNull();
    expect(report.critic?.weight).toBeCloseTo(CONFIG.critic.weight * (0.5 + 0.5 * (5 / 6)) * (5 / 6) / 0.9, 5);
    expect(report.critic?.lessons).toBe(6);
    expect(report.critic?.accepted).toBe(5);
    const md = renderMarkdown(report);
    expect(md).toContain("## Критик");
    expect(md).toMatch(/gate-pass 83%/);
    expect(md).toMatch(/≥ 50% ✓/);
  });
});
