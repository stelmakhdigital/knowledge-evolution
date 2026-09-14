import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvolveConfig } from "../src/config/config.js";
import { loadConfig } from "../src/config/config.js";
import { hashBody } from "../src/domain/hashing.js";
import { buildWeeklyReport, renderMarkdown } from "../src/report/report.js";
import { PgStore } from "../src/store/pg-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");
const DAY = 86_400_000;

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const REPORT_DB_URL = process.env["EVOLVE_REPORT_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_report_test";
const SILENT_DB_URL = process.env["EVOLVE_REPORT_SILENT_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_report_silent";

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

describe.skipIf(!pgAvailable)("недельный отчёт + алерты на живом PG (M3.2)", () => {
  let store: PgStore;
  let clockNow: Date;
  const setClock = (d: Date): void => {
    clockNow = d;
  };

  async function seedItem(
    id: string,
    body: string,
    ageDays: number,
    toActive: boolean,
  ): Promise<void> {
    const start = new Date(NOW.getTime() - ageDays * DAY);
    setClock(start);
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
    if (toActive) {
      setClock(new Date(start.getTime() + 1000));
      await store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
      setClock(new Date(start.getTime() + 2000));
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
      retrievedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    });
  }

  beforeAll(async () => {
    await freshDb(REPORT_DB_URL, "evolve_report_test");
    clockNow = NOW;
    store = new PgStore({ connectionString: REPORT_DB_URL, clock: () => new Date(clockNow) });
    // базовый элемент (короткое тело) — носитель success_rate-данных
    const shortId = randomUUID();
    await seedItem(shortId, "к".repeat(50), 30, true);
    // рост базы: база непустая до окна (условие success_rate_drop)
    // --- success_rate_drop: 6 вердиктов успеха 24д назад, 6 неудач 4д назад ---
    for (let i = 0; i < 6; i += 1) {
      await addUsage(shortId, "dsh", `t-prev-${i}`, true, 24);
    }
    for (let i = 0; i < 6; i += 1) {
      await addUsage(shortId, "dsh", `t-cur-${i}`, false, 4);
    }
    // --- churn: 6 demotion auto:degradation за окно (3д назад) ---
    for (let i = 0; i < 6; i += 1) {
      const id = randomUUID();
      await seedItem(id, `churn ${i}`.repeat(20), 40, true);
      const t = new Date(NOW.getTime() - 3 * DAY);
      setClock(t);
      await store.applyTransition(id, { to: "deprecated", kind: "demote", actor: "auto:degradation", reason: "seed churn" });
      setClock(NOW);
    }
    // --- очередь: элемент в queue 21д (демоция 21д назад, вне окна) ---
    const queuedId = randomUUID();
    await seedItem(queuedId, "застрял в очереди", 40, true);
    setClock(new Date(NOW.getTime() - 21 * DAY));
    await store.applyTransition(queuedId, { to: "queued", kind: "demote", actor: "auto:degradation", reason: "seed aged" });
    setClock(NOW);
    // --- противоречия: 6 открытых (3д назад) ---
    const pairIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = randomUUID();
      await seedItem(id, `пара ${i}`.repeat(10), 30, true);
      pairIds.push(id);
    }
    const old = new Date(NOW.getTime() - 3 * DAY);
    for (let i = 0; i < 6; i += 1) {
      await store.addContradiction({
        id: randomUUID(),
        itemAId: pairIds[i * 2] as string,
        itemBId: pairIds[i * 2 + 1] as string,
        severity: "med",
        status: "open",
        resolvedBy: null,
        createdAt: old.toISOString(),
      });
    }
    // --- canary-решение за окно: promote 2д назад ---
    const canaryId = randomUUID();
    setClock(new Date(NOW.getTime() - 2 * DAY));
    await store.addItem({
      item: {
        id: canaryId, type: "fact", title: "canary недели", scope: "all", tags: [],
        appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body: "canary",
        bodyHash: hashBody("canary"), embeddingId: null, scoreGlobal: 0,
        createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString(), updatedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      },
      provenance: [
        { sourceType: "human", taskId: "seed-canary", transcriptHash: "sha256:c", commit: "seed", payload: {}, createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString() },
      ],
      initialDecision: { itemId: canaryId, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
    });
    await store.applyTransition(canaryId, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    await store.applyTransition(canaryId, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed canary-pass" });
    setClock(NOW);
    // --- cost-growth: прошлая неделя — короткие тела, текущая — длинное ---
    const longId = randomUUID();
    await seedItem(longId, "д".repeat(5000), 30, true);
    await addUsage(shortId, "dsh", "t-cost-prev-1", null, 9);
    await addUsage(shortId, "dsh", "t-cost-prev-2", null, 9);
    await addUsage(longId, "dsh", "t-cost-cur-1", null, 3);
    await addUsage(longId, "dsh", "t-cost-cur-2", null, 3);
  }, 90_000);
  afterAll(async () => {
    await store.close();
  });

  it("сводка: success-rate, canary, churn, очередь + все алерты", async () => {
    // active ≥ 15 (12 пар + canary + short + long + ...), budget.active_max = 12 → алерт бюджета
    const cfg: EvolveConfig = { ...CONFIG, budget: { ...CONFIG.budget, active_max: 12 } };
    const report = await buildWeeklyReport(store.pool, cfg, NOW);

    const dsh = report.successByAgent.find((a) => a.agentId === "dsh");
    expect(dsh).toBeDefined();
    // за 14д: 6 неудач (4д) + 4 без вердикта... вердикты: 6 (cur, false) → successRate 0
    expect(dsh?.verdicts).toBe(6);
    expect(dsh?.successRate).toBe(0);

    expect(report.canary.promoted).toHaveLength(1);
    expect(report.canary.promoted[0]).toMatch(/canary недели/);
    expect(report.churn.demotes).toBe(6);
    expect(report.queueAged).toHaveLength(1);
    expect(report.queueAged[0].days).toBeGreaterThanOrEqual(20); // 21д − дрейф реального now()

    const codes = new Set(report.alerts.map((a) => a.code));
    expect(codes).toContain("success_rate_drop");
    expect(codes).toContain("churn");
    expect(codes).toContain("queue_card_aged");
    expect(codes).toContain("open_contradictions");
    expect(codes).toContain("active_budget");
    expect(codes).toContain("cost_growth");

    const md = renderMarkdown(report);
    expect(md).toContain("# Недельный отчёт");
    expect(md).toContain("[churn]");
    expect(md).toContain("dsh: success 0.0%");
  });

  it("система молчит: без сигналов — алертов нет (ТЗ §12.2)", async () => {
    await freshDb(SILENT_DB_URL, "evolve_report_silent");
    const silent = new PgStore({ connectionString: SILENT_DB_URL, clock: () => new Date(clockNow) });
    try {
      const id = randomUUID();
      const start = new Date(NOW.getTime() - 3 * DAY);
      await silent.addItem({
        item: {
          id, type: "fact", title: "тихий элемент", scope: "all", tags: [],
          appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body: "тело",
          bodyHash: hashBody("тело"), embeddingId: null, scoreGlobal: 0,
          createdAt: start.toISOString(), updatedAt: start.toISOString(),
        },
        provenance: [
          { sourceType: "human", taskId: "seed-silent", transcriptHash: "sha256:s", commit: "seed", payload: {}, createdAt: start.toISOString() },
        ],
        initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
      });
      await silent.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
      await silent.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
      await silent.addUsage({
        id: randomUUID(), itemId: id, version: 1, agentId: "dsh", taskId: "t-silent-0",
        taskSuccess: true, retrievedAt: new Date(NOW.getTime() - DAY).toISOString(),
      });
      const report = await buildWeeklyReport(silent.pool, CONFIG, NOW);
      expect(report.alerts).toHaveLength(0);
      expect(renderMarkdown(report)).toContain("- нет (система молчит)");
      expect(report.successByAgent[0]?.successRate).toBe(1);
    } finally {
      await silent.close();
    }
  });
});
