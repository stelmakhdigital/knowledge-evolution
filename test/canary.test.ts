import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { evaluateCanaries } from "../src/canary/canary.js";
import { hashBody } from "../src/domain/hashing.js";
import type { Item } from "../src/domain/types.js";
import { computeAgentScore, itemScoreFor, recomputeScores } from "../src/telemetry/score.js";
import { PgStore } from "../src/store/pg-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");

// --- чистые функции score ---

describe("computeAgentScore (ТЗ §11.3: 0.5·sr + 0.3·usage_norm + 0.2·recency)", () => {
  it("used ≥ min_used: веса складываются", () => {
    const r = computeAgentScore(
      CONFIG,
      { used: 10, successCount: 8, verdictCount: 10, lastUsedAt: new Date(NOW.getTime() - 86_400_000).toISOString() },
      NOW,
    );
    // sr=0.8 → 0.4; usage_norm=min(1,10/5)=1 → 0.3; recency=1−1/21≈0.9524 → ≈0.1905
    expect(r.components.success_rate).toBe(0.8);
    expect(r.components.usage_norm).toBe(1);
    expect(r.score).toBeCloseTo(0.5 * 0.8 + 0.3 * 1 + 0.2 * (1 - 1 / 21), 4);
  });

  it("used < min_used — нет сигнала (score=null)", () => {
    const r = computeAgentScore(CONFIG, { used: 4, successCount: 4, verdictCount: 4, lastUsedAt: NOW.toISOString() }, NOW);
    expect(r.score).toBeNull();
    expect(r.components.used).toBe(4);
  });

  it("без вердиктов — success_rate нейтрально 0.5", () => {
    const r = computeAgentScore(
      CONFIG,
      { used: 5, successCount: 0, verdictCount: 0, lastUsedAt: NOW.toISOString() },
      NOW,
    );
    expect(r.components.success_rate).toBe(0.5);
    expect(r.score).not.toBeNull();
  });

  it("recency: 21 день без использования → 0", () => {
    const r = computeAgentScore(
      CONFIG,
      { used: 5, successCount: 5, verdictCount: 5, lastUsedAt: new Date(NOW.getTime() - 21 * 86_400_000).toISOString() },
      NOW,
    );
    expect(r.components.recency).toBeCloseTo(0, 5);
  });
});

// --- PG: recompute + canary-цикл ---

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const CANARY_DB_URL = process.env["EVOLVE_CANARY_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_canary_test";

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

describe.skipIf(!pgAvailable)("score + canary на живом PG (M2.3)", () => {
  let store: PgStore;
  let clockNow: Date;

  const setClock = (d: Date): void => {
    clockNow = d;
  };

  async function seedItem(
    id: string,
    body: string,
    status: "active" | "canary" | "candidate",
    canaryStartDaysAgo?: number,
  ): Promise<void> {
    const startAt = canaryStartDaysAgo != null ? new Date(NOW.getTime() - canaryStartDaysAgo * 86_400_000) : new Date(NOW.getTime() - 9 * 86_400_000);
    setClock(startAt);
    await store.addItem({
      item: {
        id, type: "heuristic", title: `элемент ${id.slice(0, 6)}`, scope: "all", tags: [],
        appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body,
        bodyHash: hashBody(body), embeddingId: null, scoreGlobal: 0,
        createdAt: startAt.toISOString(), updatedAt: startAt.toISOString(),
      },
      provenance: [
        { sourceType: "human", taskId: `seed-${id.slice(0, 4)}`, transcriptHash: `sha256:${id.slice(0, 4)}`, commit: "seed", payload: {}, createdAt: startAt.toISOString() },
      ],
      initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
    });
    if (status === "canary" || status === "active") {
      setClock(new Date(startAt.getTime() + 1000));
      await store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    }
    if (status === "active") {
      setClock(new Date(startAt.getTime() + 2000));
      await store.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
    }
    setClock(NOW);
  }

  async function addUsage(itemId: string, agentId: string, taskId: string, success: boolean | null, daysAgo: number): Promise<void> {
    await store.addUsage({
      id: randomUUID(),
      itemId,
      version: 1,
      agentId,
      taskId,
      taskSuccess: success,
      retrievedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    });
  }

  beforeAll(async () => {
    await freshDb(CANARY_DB_URL, "evolve_canary_test");
    clockNow = NOW;
    store = new PgStore({ connectionString: CANARY_DB_URL, clock: () => new Date(clockNow) });
  }, 60_000);
  afterAll(async () => {
    await store.close();
  });

  it("recomputeScores: строки item_scores, used<5 → NULL, score_global по агентам", async () => {
    const good = randomUUID();
    const few = randomUUID();
    await seedItem(good, "хороший элемент для score", "active");
    await seedItem(few, "элемент с малым usage", "active");
    for (let i = 0; i < 5; i += 1) {
      await addUsage(good, "dsh", `t-good-${i}`, true, i);
    }
    await addUsage(good, "dsh", "t-good-x", false, 0);
    await addUsage(few, "dsh", "t-few-0", true, 0);

    const n = await recomputeScores(store.pool, CONFIG, NOW);
    expect(n).toBeGreaterThanOrEqual(2);

    const goodScore = await itemScoreFor(store.pool, good, "dsh");
    expect(goodScore.source).toBe("agent");
    expect(goodScore.score).toBeGreaterThan(0.6); // sr=5/6≈0.83 → ≥0.41 + остальные
    const fewScore = await itemScoreFor(store.pool, few, "dsh");
    expect(fewScore.source).toBe("global"); // used=1 < 5 → fallback

    const global = await store.getItem(good);
    expect(global?.scoreGlobal).toBeGreaterThan(0);
  });

  it("canary-pass: success_rate ≥ baseline−ε → active, decision auto:canary", async () => {
    // baseline: active-ядро со 100% success
    const baseline = randomUUID();
    await seedItem(baseline, "базовый активный элемент", "active");
    for (let i = 0; i < 6; i += 1) {
      await addUsage(baseline, "dsh", `t-base-${i}`, true, i);
    }
    // canary 8 дней, 4 извлечения, все успехи
    const c = randomUUID();
    await seedItem(c, "отличный canary элемент", "canary", 8);
    for (let i = 0; i < 4; i += 1) {
      await addUsage(c, "dsh", `t-c1-${i}`, true, i);
    }
    const verdicts = await evaluateCanaries(store, CONFIG, NOW);
    const v = verdicts.find((x) => x.itemId === c);
    expect(v?.outcome).toBe("promote");
    expect(v?.evidence["success_rate"]).toBe(1);
    const item = await store.getItem(c);
    expect(item?.status).toBe("active");
    const decisions = await store.decisionsFor(c);
    const last = decisions.at(-1);
    expect(last?.actor).toBe("auto:canary");
    expect(last?.kind).toBe("promote");
  });

  it("canary-fail: success_rate ниже порога → candidate (flag, повтор новым кандидатом)", async () => {
    const c = randomUUID();
    await seedItem(c, "плохой canary элемент", "canary", 8);
    await addUsage(c, "dsh", "t-bad-0", true, 1);
    await addUsage(c, "dsh", "t-bad-1", false, 1);
    await addUsage(c, "dsh", "t-bad-2", false, 1);
    const verdicts = await evaluateCanaries(store, CONFIG, NOW);
    const v = verdicts.find((x) => x.itemId === c);
    expect(v?.outcome).toBe("demote");
    expect(v?.reason).toMatch(/canary-fail/);
    expect((await store.getItem(c))?.status).toBe("candidate");
  });

  it("hold: недостаточно извлечений / окно не истекло", async () => {
    const few = randomUUID();
    await seedItem(few, "canary без данных", "canary", 8);
    await addUsage(few, "dsh", "t-few-c-0", true, 1);
    const early = randomUUID();
    await seedItem(early, "свежий canary", "canary", 2); // окно 2д < 7д
    await addUsage(early, "dsh", "t-early-0", true, 0);
    await addUsage(early, "dsh", "t-early-1", true, 0);
    await addUsage(early, "dsh", "t-early-2", true, 0);

    const verdicts = await evaluateCanaries(store, CONFIG, NOW);
    const vf = verdicts.find((x) => x.itemId === few);
    expect(vf?.outcome).toBe("hold");
    expect(vf?.reason).toMatch(/извлечений/);
    const ve = verdicts.find((x) => x.itemId === early);
    expect(ve?.outcome).toBe("hold");
    expect(ve?.reason).toMatch(/окно/);
    expect((await store.getItem(few))?.status).toBe("canary");
    expect((await store.getItem(early))?.status).toBe("canary");
  });

  it("cost-gate: тело дороже baseline × 1.2 → demote (ТЗ §9.1)", async () => {
    const c = randomUUID();
    const hugeBody = "x".repeat(6000); // >> 1.2× среднего по active
    await seedItem(c, `огромный canary ${hugeBody.slice(0, 20)}`, "canary", 8);
    // подменяем тело через версию, чтобы body.length вырос (approve_edit)
    await store.addVersion(c, hugeBody, {
      kind: "approve_edit", actor: "human", reason: "test: большое тело", evidence: {},
    });
    for (let i = 0; i < 4; i += 1) {
      await addUsage(c, "dsh", `t-cost-${i}`, true, i);
    }
    const verdicts = await evaluateCanaries(store, CONFIG, NOW);
    const v = verdicts.find((x) => x.itemId === c);
    expect(v?.outcome).toBe("demote");
    expect(v?.reason).toMatch(/cost-gate/);
    expect((await store.getItem(c))?.status).toBe("candidate");
  });

  it("идемпотентность: повторный прогон не создаёт новых переходов", async () => {
    const before = await store.pool.query(`SELECT count(*)::int AS n FROM decisions`);
    const verdicts = await evaluateCanaries(store, CONFIG, NOW);
    // оставшиеся canary (hold) не меняют статус; promote/demote повторных нет
    const transitions = verdicts.filter((v) => v.outcome !== "hold");
    expect(transitions).toHaveLength(0);
    const after = await store.pool.query(`SELECT count(*)::int AS n FROM decisions`);
    expect(Number(after.rows[0]["n"])).toBe(Number(before.rows[0]["n"]));
  });
});
