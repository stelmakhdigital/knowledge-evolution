import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTransition } from "../src/domain/state-machine.js";
import type { EvolveConfig } from "../src/config/config.js";
import { loadConfig } from "../src/config/config.js";
import { runDecay } from "../src/decay/decay.js";
import { hashBody } from "../src/domain/hashing.js";
import { recomputeScores } from "../src/telemetry/score.js";
import { PgStore } from "../src/store/pg-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");
const DAY = 86_400_000;

// --- стейт-машина: ребро rollback ---

describe("стейт-машина: deprecated → active (kind=rollback)", () => {
  it("rollback разрешён human и auto", () => {
    for (const actor of ["human:anna", "auto:canary"]) {
      const edge = checkTransition({ from: "deprecated", to: "active", kind: "rollback", actor });
      expect(edge.to).toBe("active");
    }
  });

  it("rollback запрещён из других статусов / с чужим kind", () => {
    expect(() =>
      checkTransition({ from: "active", to: "deprecated", kind: "rollback", actor: "human:x" }),
    ).toThrow(/запрещён|kind=/);
    expect(() =>
      checkTransition({ from: "deprecated", to: "active", kind: "demote", actor: "human:x" }),
    ).toThrow(/запрещён|kind=/);
  });
});

// --- PG: decay ---

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const DECAY_DB_URL = process.env["EVOLVE_DECAY_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_decay_test";

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

describe.skipIf(!pgAvailable)("decay на живом PG (M3.1)", () => {
  let store: PgStore;
  let clockNow: Date;
  const setClock = (d: Date): void => {
    clockNow = d;
  };

  async function seedActive(id: string, ageDays: number): Promise<void> {
    const start = new Date(NOW.getTime() - ageDays * DAY);
    setClock(start);
    const body = `тело элемента ${id.slice(0, 6)}`;
    await store.addItem({
      item: {
        id, type: "heuristic", title: `элемент ${id.slice(0, 6)}`, scope: "all", tags: [],
        appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body,
        bodyHash: hashBody(body), embeddingId: null, scoreGlobal: 0,
        createdAt: start.toISOString(), updatedAt: start.toISOString(),
      },
      provenance: [
        { sourceType: "human", taskId: `seed-${id.slice(0, 4)}`, transcriptHash: `sha256:${id.slice(0, 4)}`, commit: "seed", payload: {}, createdAt: start.toISOString() },
      ],
      initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
    });
    setClock(new Date(start.getTime() + 1000));
    await store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    setClock(new Date(start.getTime() + 2000));
    await store.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
    setClock(NOW);
  }

  async function seedBallast(n: number): Promise<void> {
    // Свежие активные элементы с usage сегодня: не трогаются decay, но увеличивают
    // знаменатель over-pruning guard (малая тестовая база).
    for (let i = 0; i < n; i += 1) {
      const id = randomUUID();
      await seedActive(id, 1);
      await addUsage(id, `t-ballast-${id.slice(0, 4)}`, true, 0);
    }
  }

  async function addUsage(itemId: string, taskId: string, success: boolean | null, daysAgo: number): Promise<void> {
    await store.addUsage({
      id: randomUUID(),
      itemId,
      version: 1,
      agentId: "dsh",
      taskId,
      taskSuccess: success,
      retrievedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    });
  }

  beforeAll(async () => {
    await freshDb(DECAY_DB_URL, "evolve_decay_test");
    clockNow = NOW;
    store = new PgStore({ connectionString: DECAY_DB_URL, clock: () => new Date(clockNow) });
  }, 60_000);
  afterAll(async () => {
    await store.close();
  });

  it("unused: 25д без использования → deprecated (auto:degradation)", async () => {
    const id = randomUUID();
    await seedActive(id, 25);
    await seedBallast(4);
    const actions = await runDecay(store, CONFIG, NOW);
    const a = actions.find((x) => x.itemId === id);
    expect(a?.kind).toBe("demote");
    expect(a?.reason).toMatch(/25д без использования/);
    expect((await store.getItem(id))?.status).toBe("deprecated");
    const dec = (await store.decisionsFor(id)).at(-1);
    expect(dec?.actor).toBe("auto:degradation");
  });

  it("θ_score: score < θ при used ≥ 5 → deprecated (кастомный порог 0.6)", async () => {
    const id = randomUUID();
    await seedActive(id, 2); // свежий — unused не сработает
    await seedBallast(4);
    for (let i = 0; i < 5; i += 1) {
      await addUsage(id, `t-theta-${i}`, i === 0 ? true : false, 30); // recency=0 → score 0.4
    }
    await recomputeScores(store.pool, CONFIG, NOW);
    const cfg: EvolveConfig = {
      ...CONFIG,
      theta_score: 0.6,
      degradation: { ...CONFIG.degradation, unused_days: 60 },
    };
    const actions = await runDecay(store, cfg, NOW);
    const a = actions.find((x) => x.itemId === id);
    expect(a?.kind).toBe("demote");
    expect(a?.reason).toMatch(/score_global/);
    expect((await store.getItem(id))?.status).toBe("deprecated");
  });

  it("свежий активный элемент не трогается", async () => {
    const id = randomUUID();
    await seedActive(id, 1);
    await addUsage(id, "t-fresh-0", true, 0);
    const actions = await runDecay(store, CONFIG, NOW);
    expect(actions.find((x) => x.itemId === id)).toBeUndefined();
    expect((await store.getItem(id))?.status).toBe("active");
  });

  it("deprecated 31д → archived (с archived_reason)", async () => {
    const id = randomUUID();
    const old = new Date(NOW.getTime() - 31 * DAY);
    setClock(old);
    await store.addItem({
      item: {
        id, type: "fact", title: "старый deprecated", scope: "all", tags: [],
        appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body: "тело",
        bodyHash: hashBody("тело"), embeddingId: null, scoreGlobal: 0,
        createdAt: old.toISOString(), updatedAt: old.toISOString(),
      },
      provenance: [
        { sourceType: "human", taskId: "seed-old", transcriptHash: "sha256:old", commit: "seed", payload: {}, createdAt: old.toISOString() },
      ],
      initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
    });
    await store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    await store.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
    setClock(old);
    await store.applyTransition(id, { to: "deprecated", kind: "demote", actor: "auto:degradation", reason: "seed" });
    setClock(NOW);

    const actions = await runDecay(store, CONFIG, NOW);
    const a = actions.find((x) => x.itemId === id);
    expect(a?.kind).toBe("archive");
    const item = await store.getItem(id);
    expect(item?.status).toBe("archived");
    expect(item?.archivedReason).toMatch(/30д без восстановления/);
  });

  it("открытое contradiction > 7д → активные участники в queued", async () => {
    const a1 = randomUUID();
    const b1 = randomUUID();
    await seedActive(a1, 1);
    await seedActive(b1, 1);
    await addUsage(a1, "t-contr-a", true, 0);
    await addUsage(b1, "t-contr-b", true, 0);
    const old = new Date(NOW.getTime() - 10 * DAY);
    await store.addContradiction({
      id: randomUUID(),
      itemAId: a1,
      itemBId: b1,
      severity: "med",
      status: "open",
      resolvedBy: null,
      createdAt: old.toISOString(),
    });
    const actions = await runDecay(store, CONFIG, NOW);
    const queueActions = actions.filter((x) => x.kind === "queue_contradiction");
    expect(queueActions).toHaveLength(2);
    expect((await store.getItem(a1))?.status).toBe("queued");
    expect((await store.getItem(b1))?.status).toBe("queued");
  });

  it("over-pruning guard: не более 0.2 × active demotion за месяц", async () => {
    // 20 активных, все 25д без использования; guard = floor(0.2 × nActive) минус
    // demotion этого месяца, уже сделанные предыдущими тестами (unused + θ_score).
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = randomUUID();
      await seedActive(id, 25);
      ids.push(id);
    }
    const monthStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)).toISOString();
    const prior = await store.pool.query(
      `SELECT count(*)::int AS n FROM decisions WHERE actor = 'auto:degradation' AND kind = 'demote' AND created_at >= $1`,
      [monthStart],
    );
    // Знаменатель guard — вся неархивированная база (М3-приближение, как в runDecay).
    const nBase = await store.pool.query(`SELECT count(*)::int AS n FROM items WHERE status <> 'archived'`);
    const expected = Math.max(
      0,
      Math.floor(CONFIG.degradation.max_deprecated_share_per_month * Number(nBase.rows[0]["n"])) -
        Number(prior.rows[0]["n"]),
    );
    expect(expected).toBeGreaterThan(0);

    const actions = await runDecay(store, CONFIG, NOW);
    const mine = actions.filter((x) => ids.includes(x.itemId));
    const demoted = mine.filter((x) => x.kind === "demote");
    const skipped = mine.filter((x) => x.kind === "skipped_guard");
    expect(demoted).toHaveLength(expected);
    expect(skipped).toHaveLength(20 - expected);
    // Не загрязняем следующие тесты: даём элементам свежий usage (они перестают быть stale).
    for (const id of ids) {
      await addUsage(id, `t-unstale-${id.slice(0, 4)}`, true, 0);
    }
  });

  it("rollback одним кликом: deprecated → active (kind=rollback, actor=human)", async () => {
    const id = randomUUID();
    await seedActive(id, 25);
    await seedBallast(4);
    const before = (await store.decisionsFor(id)).length;
    await runDecay(store, CONFIG, NOW);
    expect((await store.getItem(id))?.status).toBe("deprecated");

    const updated = await store.applyTransition(id, {
      to: "active", kind: "rollback", actor: "human:anna", reason: "rollback (ТЗ §12.1)", evidence: {},
    });
    expect(updated.status).toBe("active");
    const decs = await store.decisionsFor(id);
    expect(decs).toHaveLength(before + 2); // demote + rollback
    expect(decs.at(-1)?.kind).toBe("rollback");
    expect(decs.at(-1)?.actor).toBe("human:anna");

    // повторный rollback из active запрещён
    await expect(
      store.applyTransition(id, {
        to: "deprecated", kind: "rollback", actor: "human:anna", reason: "x", evidence: {},
      }),
    ).rejects.toThrow();
  });
});
