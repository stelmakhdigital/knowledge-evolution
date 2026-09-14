import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { hashBody } from "../src/domain/hashing.js";
import type { Item } from "../src/domain/types.js";
import {
  applyBudget,
  finalRank,
  ftsTokens,
  rrfFuse,
  retrieve,
  type RetrieveResult,
} from "../src/retrieval/search.js";
import { formatResponse } from "../src/service/retrieve.js";
import { PgStore } from "../src/store/pg-store.js";
import { GOLDEN_ITEMS, GOLDEN_TASKS } from "./golden/golden.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");

// --- чистые функции (без БД) ---

describe("ftsTokens", () => {
  it("берёт только безопасные лексемы, режет операторы tsquery", () => {
    expect(ftsTokens("SELECT * FROM items WHERE")).toEqual(["select", "from", "items", "where"]);
    expect(ftsTokens("src/db/** migration-тест 42")).toEqual(["src", "db", "migration", "тест", "42"]);
    expect(ftsTokens("!!!")).toEqual([]);
  });
});

describe("rrfFuse (ТЗ §10.1)", () => {
  it("суммирует 1/(k+rank) по каналам, ранги 1-based", () => {
    const fused = rrfFuse(
      { keyword: ["a", "b", "c"], vector: ["b", "a", "d"] },
      60,
    );
    // a: 1/61 (kw#1) + 1/62 (vec#2); b: 1/62 + 1/61; c: 1/63; d: 1/63
    expect(fused.get("a")?.score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused.get("b")?.score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused.get("c")?.score).toBeCloseTo(1 / 63);
    expect(fused.get("a")?.channels).toContain("keyword");
    expect(fused.get("a")?.channels).toContain("vector");
  });
});

describe("applyBudget (ТЗ §19: budget-гварды)", () => {
  const item = (id: string, body: string): { item: Item; body: string } => ({
    item: {
      id, type: "fact", title: id, scope: "all", tags: [], appliesTo: "all", status: "active",
      riskTier: "low", version: 1, body, bodyHash: hashBody(body), embeddingId: null,
      scoreGlobal: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    },
    body,
  });

  it("обрезает тело до max_chars_per_item", () => {
    const long = "x".repeat(3000);
    const { items, truncated } = applyBudget([item("a", long)], CONFIG);
    expect(truncated).toBe(true);
    expect(items[0]?.body.length).toBeLessThanOrEqual(CONFIG.retrieval.budget.max_chars_per_item + 1);
  });

  it("держит total-бюджет: не влезшее обрывается", () => {
    const bodyA = "а".repeat(5000);
    const bodyB = "б".repeat(5000);
    const { items, truncated } = applyBudget([item("a", bodyA), item("b", bodyB)], CONFIG);
    // per-item 2000 → каждый ≤ 2001, total 8000 → оба влезает
    expect(items).toHaveLength(2);
    const total = items.reduce((s, i) => s + i.body.length, 0);
    expect(total).toBeLessThanOrEqual(CONFIG.retrieval.budget.max_total_recall_chars);
    expect(truncated).toBe(true);

    const huge = Array.from({ length: 8 }, (_, i) => item(`h${i}`, "у".repeat(1500)));
    const r2 = applyBudget(huge, CONFIG);
    expect(r2.truncated).toBe(true);
    const total2 = r2.items.reduce((s, i) => s + i.body.length, 0);
    expect(total2).toBeLessThanOrEqual(CONFIG.retrieval.budget.max_total_recall_chars);
  });
});

describe("finalRank (веса config.retrieval.weights)", () => {
  function makeRows(rows: Array<{ id: string; scope: string; score: number; ageDays: number }>) {
    const map = new Map(rows.map((r) => [
      r.id,
      {
        id: r.id, title: r.id, scope: r.scope, tags: [], body: "тело", version: 1,
        score: r.score, created_at: new Date(NOW.getTime() - r.ageDays * 86_400_000),
      },
    ]));
    return map;
  }

  it("scope-подсказка поднимает элемент, старый — давит recency", () => {
    const fused = new Map([
      ["fresh-all", { score: 1, channels: ["keyword"] }],
      ["old-match", { score: 1, channels: ["keyword"] }],
    ]);
    const items = makeRows([
      { id: "fresh-all", scope: "all", score: 0.5, ageDays: 1 },
      { id: "old-match", scope: "all", score: 0.5, ageDays: 60 },
    ]);
    const ranked = finalRank(fused, items, CONFIG, [], NOW);
    expect(ranked[0]?.id).toBe("fresh-all");

    const fused2 = new Map([
      ["scope-hit", { score: 0.7, channels: ["vector"] }],
      ["scope-miss", { score: 0.9, channels: ["keyword"] }],
    ]);
    const items2 = makeRows([
      { id: "scope-hit", scope: "db/migrations", score: 0.2, ageDays: 1 },
      { id: "scope-miss", scope: "src/web/**", score: 0.2, ageDays: 1 },
    ]);
    const ranked2 = finalRank(fused2, items2, CONFIG, ["db/migrations"], NOW);
    expect(ranked2[0]?.id).toBe("scope-hit");
  });
});

describe("formatResponse (ТЗ §14.2: формат по профилю)", () => {
  const result: RetrieveResult = {
    items: [
      {
        item: {
          id: "x1", type: "fact", title: "Заголовок", scope: "all", tags: [], appliesTo: "all",
          status: "active", riskTier: "low", version: 1, body: "тело", bodyHash: "", embeddingId: null,
          scoreGlobal: 0.5, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        },
        body: "тело", channels: ["keyword"], finalScore: 0.9,
      },
    ],
    truncated: false,
    tookMs: 3,
    timedOut: false,
  };
  it("json — payload; markdown — читаемый блок; tool_call — обёртка", () => {
    const json = formatResponse(result, "json", null) as Record<string, unknown>;
    expect((json["items"] as unknown[])).toHaveLength(1);
    const md = formatResponse(result, "markdown", { retrievalTopK: 5 }) as Record<string, unknown>;
    expect(String(md["markdown"])).toContain("Заголовок");
    const tc = formatResponse(result, "tool_call", null) as Record<string, unknown>;
    expect(tc["tool"]).toBe("knowledge");
  });
});

// --- PG: end-to-end retrieval + golden-критерий M2 ---

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const RETR_DB_URL = process.env["EVOLVE_RETR_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_retrieval_test";

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

async function freshRetrDb(): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS evolve_retrieval_test WITH (FORCE)`);
    await admin.query(`CREATE DATABASE evolve_retrieval_test`);
  } finally {
    await admin.end();
  }
  const pool = new Pool({ connectionString: RETR_DB_URL, max: 2 });
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

async function seedGolden(store: PgStore): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const gi of GOLDEN_ITEMS) {
    const id = randomUUID();
    ids.set(gi.id, id);
    const body = gi.body;
    await store.addItem({
      item: {
        id,
        type: gi.type,
        title: gi.title,
        scope: gi.scope,
        tags: [...gi.tags],
        appliesTo: gi.appliesTo,
        status: "candidate",
        riskTier: gi.type === "negative" ? "high" : "low",
        version: 1,
        body,
        bodyHash: hashBody(body),
        embeddingId: null,
        scoreGlobal: 0.4,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      provenance: [
        {
          sourceType: "human",
          taskId: `golden-${gi.id}`,
          transcriptHash: `sha256:${gi.id}`,
          commit: "golden",
          payload: { source: "golden-seed" },
          createdAt: NOW.toISOString(),
        },
      ],
      initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "golden", evidence: {} },
    });
    if (gi.status === "archived") {
      await store.applyTransition(id, {
        to: "archived", kind: "reject", actor: "human",
        reason: "golden: архив", archivedReason: "golden: архив",
      });
    } else if (gi.status === "canary") {
      await store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    } else {
      await store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
      await store.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "golden" });
    }
  }
  return ids;
}

describe.skipIf(!pgAvailable)("retrieval на живом PG (M2)", () => {
  let store: PgStore;
  let ids: Map<string, string>;

  const beforeAllHook = async (): Promise<void> => {
    await freshRetrDb();
    store = new PgStore({ connectionString: RETR_DB_URL, clock: () => NOW });
    ids = await seedGolden(store);
  };

  const afterAllHook = async (): Promise<void> => {
    await store.close();
  };

  beforeAll(beforeAllHook, 60_000);
  afterAll(afterAllHook);

  it("golden: recall@5 ≥ 0.7 на 30 задачах (критерий M2, ТЗ §15)", async () => {
    let total = 0;
    const fails: string[] = [];
    for (const task of GOLDEN_TASKS) {
      const res = await retrieve(
        store.pool,
        {
          query: task.query,
          agentId: "dsh",
          scopeHints: task.scopeHints,
        },
        CONFIG,
        new (await import("../src/llm/client.js")).MockLlm(),
        NOW,
      );
      const top5 = new Set(res.items.map((r) => r.item.id));
      const expected = task.expected.map((g) => ids.get(g) as string);
      const hits = expected.filter((id) => top5.has(id)).length;
      total += hits / expected.length;
      if (hits < expected.length) {
        fails.push(`${task.id} (${task.query.slice(0, 40)}): ${expected.length - hits}/${expected.length}`);
      }
    }
    const recall = total / GOLDEN_TASKS.length;
    if (fails.length > 0) {
      console.log("recall-промахи:\n" + fails.join("\n"));
    }
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });

  it("archived элементы не извлекаются (g11)", async () => {
    const res = await retrieve(
      store.pool,
      { query: "legacy-x фреймворк ветка legacy, использовать можно", agentId: "dsh" },
      CONFIG,
      new (await import("../src/llm/client.js")).MockLlm(),
      NOW,
    );
    expect(res.items.map((r) => r.item.id)).not.toContain(ids.get("g11"));
  });

  it("applies_to: элемент dsh-специфики виден только dsh (ТЗ §14.2)", async () => {
    const llm = new (await import("../src/llm/client.js")).MockLlm();
    const forDsh = await retrieve(
      store.pool,
      { query: "grep по node_modules медленно, как искать зависимости", agentId: "dsh" },
      CONFIG, llm, NOW,
    );
    expect(forDsh.items.map((r) => r.item.id)).toContain(ids.get("g12"));
    const forOther = await retrieve(
      store.pool,
      { query: "grep по node_modules медленно, как искать зависимости", agentId: "claude" },
      CONFIG, llm, NOW,
    );
    expect(forOther.items.map((r) => r.item.id)).not.toContain(ids.get("g12"));
  });

  it("task_id → запись usage_log (знание доступно ДО задачи, ТЗ §10.3)", async () => {
    const taskId = `retr-task-${randomUUID()}`;
    const res = await retrieve(
      store.pool,
      { query: "миграции базы данных схема, порядок", agentId: "dsh", taskId },
      CONFIG,
      new (await import("../src/llm/client.js")).MockLlm(),
      NOW,
    );
    expect(res.items.length).toBeGreaterThan(0);
    const usage = await store.usageForTask(taskId);
    expect(usage.length).toBe(res.items.length);
    expect(usage.every((u) => u.taskSuccess === null)).toBe(true);
  });

  it("ленивое индексирование: embeddings появились только у retrievable", async () => {
    const pool = store.pool;
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM embeddings`,
    );
    const retrievable = await pool.query(
      `SELECT count(*)::int AS n FROM items WHERE status IN ('active', 'canary')`,
    );
    expect(count.rows[0]["n"]).toBe(retrievable.rows[0]["n"]);
  });
});
