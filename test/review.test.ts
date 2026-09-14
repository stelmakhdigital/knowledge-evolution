import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { hashBody } from "../src/domain/hashing.js";
import type { Candidate } from "../src/domain/types.js";
import { gateEvidence } from "../src/gates/gates.js";
import { MockLlm } from "../src/llm/client.js";
import { recordReview } from "../src/review/review.js";
import { MemoryStore } from "../src/store/memory-store.js";
import { PgStore } from "../src/store/pg-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");

function reviewCandidate(over: Partial<Candidate["provenance"]> = {}): Candidate {
  return {
    type: "heuristic",
    title: "lesson из ревью",
    scope: "all",
    tags: ["review"],
    appliesTo: "all",
    body: "пробегать lint перед коммитом",
    provenance: {
      sourceType: "critic",
      taskId: "task-1",
      transcriptHash: "sha256:abc",
      commit: "deadbeef",
      payload: { rating: 2 },
      createdAt: NOW.toISOString(),
      ...over,
    },
  };
}

describe("G1 для review/critic (ТЗ §13: фидбэк = верификация)", () => {
  const store = new MemoryStore();
  const ctxBase = (c: Candidate) => ({
    candidate: c,
    candidateRef: "rvw-test",
    store: store,
    config: CONFIG,
    llm: new MockLlm(),
    clock: () => NOW,
    agentId: "dsh",
  });

  it("pass: task_id + transcript_hash + rating 1..5", () => {
    for (const rating of [1, 3, 5]) {
      const r = gateEvidence(ctxBase(reviewCandidate({ payload: { rating } })));
      expect(r.outcome).toBe("pass");
      expect(r.detail["rating"]).toBe(rating);
    }
  });

  it("fail: без rating / вне диапазона / без task_id / без transcript", () => {
    expect(gateEvidence(ctxBase(reviewCandidate({ payload: {} }))).outcome).toBe("fail");
    expect(gateEvidence(ctxBase(reviewCandidate({ payload: { rating: 6 } }))).outcome).toBe("fail");
    expect(gateEvidence(ctxBase(reviewCandidate({ taskId: "" }))).outcome).toBe("fail");
    expect(gateEvidence(ctxBase(reviewCandidate({ transcriptHash: "" }))).outcome).toBe("fail");
  });

  it("sourceType=human (review) работает так же", () => {
    const r = gateEvidence(ctxBase(reviewCandidate({ sourceType: "review", payload: { rating: 5 } })));
    expect(r.outcome).toBe("pass");
    expect(r.detail["source"]).toBe("review");
  });

  it("regression: success-провенанс без verifier по-прежнему fail", () => {
    const r = gateEvidence(
      ctxBase(
        reviewCandidate({
          sourceType: "success",
          payload: {},
        }),
      ),
    );
    expect(r.outcome).toBe("fail");
  });
});

// --- PG e2e: review → конвейер ---

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const REVIEW_DB_URL = process.env["EVOLVE_REVIEW_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_review_test";

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

describe.skipIf(!pgAvailable)("review → конвейер на живом PG (M4.1)", () => {
  let store: PgStore;

  beforeAll(async () => {
    await freshDb(REVIEW_DB_URL, "evolve_review_test");
    store = new PgStore({ connectionString: REVIEW_DB_URL, clock: () => new Date(NOW) });
  }, 60_000);
  afterAll(async () => {
    await store.close();
  });

  it("critic review: событие + lesson-кандидат в queue (heuristic, scope=all → high)", async () => {
    const outcome = await recordReview(
      store,
      CONFIG,
      {
        taskId: "task-r1",
        source: "critic",
        agentId: "dsh",
        rating: 2,
        transcriptHash: "sha256:r1",
        commit: "cafe0001",
        issues: [
          {
            type: "bug",
            severity: "high",
            evidence: "src/api/handler.ts:42",
            lessonCandidate: "проверять код ответа БД перед кэшированием",
          },
        ],
        llm: new MockLlm(),
      },
      NOW,
    );
    expect(outcome.candidates).toHaveLength(1);
    const res = outcome.candidates[0];
    expect(res.gates.decision).toBe("accept"); // accept = принят конвейером (high → queue)
    expect(res.gates.riskTier).toBe("high");
    const item = res.item;
    expect(item?.status).toBe("queued");
    expect(item?.type).toBe("heuristic");

    // событие review_recorded записано
    const events = await store.listEvents({ taskId: "task-r1" });
    const review = events.find((e) => e["event"] === "review_recorded");
    expect(review).toBeDefined();
    expect(review?.["rating"]).toBe(2);
    expect(review?.["source"]).toBe("critic");
    expect((review?.["issues"] as { lesson_candidate?: string }[])[0].lesson_candidate).toBe(
      "проверять код ответа БД перед кэшированием",
    );

    // провенанс элемента: source critic + critic_weight в payload
    const prov = await store.provenanceFor(item?.id ?? "");
    expect(prov[0]?.sourceType).toBe("critic");
    expect(prov[0]?.payload["critic_weight"]).toBe(CONFIG.critic.weight);
    expect(prov[0]?.payload["rating"]).toBe(2);
  });

  it("повторный lesson — merge (G2), не дублируется", async () => {
    const outcome = await recordReview(
      store,
      CONFIG,
      {
        taskId: "task-r2",
        source: "human",
        agentId: "dsh",
        rating: 5,
        transcriptHash: "sha256:r2",
        commit: "cafe0002",
        issues: [
          {
            type: "design",
            severity: "med",
            evidence: "тест t42",
            lessonCandidate: "проверять код ответа БД перед кэшированием",
          },
        ],
        llm: new MockLlm(),
      },
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0].gates.decision).toBe("merge");
  });

  it("issue без lesson — только телеметрия, без кандидата", async () => {
    const outcome = await recordReview(
      store,
      CONFIG,
      {
        taskId: "task-r3",
        source: "human",
        agentId: "dsh",
        rating: 4,
        transcriptHash: "sha256:r3",
        commit: "cafe0003",
        issues: [{ type: "style", severity: "low", evidence: "название функции" }],
        llm: new MockLlm(),
      },
      NOW,
    );
    expect(outcome.candidates).toHaveLength(0);
    const events = await store.listEvents({ taskId: "task-r3" });
    expect(events.some((e) => e["event"] === "review_recorded")).toBe(true);
  });

  it("rating вне 1..5 — ошибка", async () => {
    await expect(
      recordReview(
        store,
        CONFIG,
        {
          taskId: "task-r4",
          source: "critic",
          agentId: "dsh",
          rating: 0,
          transcriptHash: "sha256:r4",
          commit: "none",
          issues: [],
          llm: new MockLlm(),
        },
        NOW,
      ),
    ).rejects.toThrow(/rating/);
  });
});
