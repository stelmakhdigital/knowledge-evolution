import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import type { EvolveConfig } from "../src/config/config.js";
import { admitCandidate, type GateContext } from "../src/gates/gates.js";
import type { Candidate } from "../src/domain/types.js";
import { hashBody } from "../src/domain/hashing.js";
import { MockLlm } from "../src/llm/client.js";
import { retrieve } from "../src/retrieval/search.js";
import { recordReview } from "../src/review/review.js";
import { asyncStoreOf, type AsyncStore } from "../src/store/async-store.js";
import { MemoryStore } from "../src/store/memory-store.js";
import { PgStore } from "../src/store/pg-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");
const ablation = (over: Partial<EvolveConfig["ablation"]>): EvolveConfig => ({
  ...CONFIG,
  ablation: { ...CONFIG.ablation, ...over },
});

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    type: "heuristic",
    title: "тестовый урок",
    scope: "src/**",
    tags: ["ablation"],
    appliesTo: "all",
    body: over.body ?? "перед коммитом прогоняй линт",
    provenance: {
      sourceType: "success",
      taskId: "task-abl",
      transcriptHash: "sha256:abl",
      commit: "deadbeef",
      payload: { verifier: "tests" },
      createdAt: NOW.toISOString(),
      ...over["provenance"],
    },
    ...over,
  };
}

function ctx(
  store: AsyncStore,
  config: EvolveConfig,
  cand: Candidate,
  llm: MockLlm = new MockLlm(),
): GateContext {
  return {
    candidate: cand,
    candidateRef: `abl-${hashBody(cand.body).slice(0, 8)}-${randomUUID().slice(0, 4)}`,
    store,
    config,
    llm,
    clock: () => NOW,
    agentId: "dsh",
  };
}

describe("ablation-флаги (ТЗ §12.4, harness.md §6)", () => {
  it("dedup off: идентичные кандидаты оба принимаются; default — merge", async () => {
    const off = asyncStoreOf(new MemoryStore());
    const body = "уникальное тело для dедуп-теста ablation";
    const r1 = await admitCandidate(ctx(off, ablation({ dedup: false }), candidate({ body })));
    const r2 = await admitCandidate(ctx(off, ablation({ dedup: false }), candidate({ body })));
    expect(r1.gates.decision).toBe("accept");
    expect(r2.gates.decision).toBe("accept");
    const items = await off.listItems();
    expect(items).toHaveLength(2);

    const def = asyncStoreOf(new MemoryStore());
    const d1 = await admitCandidate(ctx(def, CONFIG, candidate({ body: body + " default" })));
    const d2 = await admitCandidate(ctx(def, CONFIG, candidate({ body: body + " default" })));
    expect(d1.gates.decision).toBe("accept");
    expect(d2.gates.decision).toBe("merge");
  });

  it("canary off: low-кандидат в queue (человек); default — canary", async () => {
    const off = asyncStoreOf(new MemoryStore());
    const rOff = await admitCandidate(ctx(off, ablation({ canary: false }), candidate()));
    expect(rOff.item?.status).toBe("queued");
    const offDec = await off.decisionsFor((rOff.item as { id: string }).id);
    expect(offDec.at(-1)?.reason).toMatch(/canary off/);

    const def = asyncStoreOf(new MemoryStore());
    const rDef = await admitCandidate(ctx(def, CONFIG, candidate()));
    expect(rDef.item?.status).toBe("canary");
  });

  it("critic off: lesson-кандидат критика отклоняется на G1; default — принимается", async () => {
    const off = asyncStoreOf(new MemoryStore());
    const offRes = await recordReview(
      off,
      ablation({ critic: false }),
      {
        taskId: "task-c-abl",
        source: "critic",
        agentId: "dsh",
        rating: 2,
        transcriptHash: "sha256:cabl",
        commit: "cafe",
        issues: [{ type: "bug", severity: "med", evidence: "f.ts:1", lessonCandidate: "урок критика для ablation" }],
        llm: new MockLlm(),
      },
      NOW,
    );
    expect(offRes.candidates[0]?.gates.decision).toBe("reject");
    const g1 = offRes.candidates[0]?.gates.results.find((g) => g.gate === "evidence");
    expect(g1?.outcome).toBe("fail");
    expect(g1?.detail["reason"]).toMatch(/критик-модуль отключён/);

    const def = asyncStoreOf(new MemoryStore());
    const defRes = await recordReview(
      def,
      CONFIG,
      {
        taskId: "task-c-abl2",
        source: "critic",
        agentId: "dsh",
        rating: 2,
        transcriptHash: "sha256:cabl2",
        commit: "cafe",
        issues: [{ type: "bug", severity: "med", evidence: "f.ts:1", lessonCandidate: "другой урок критика ablation" }],
        llm: new MockLlm(),
      },
      NOW,
    );
    expect(defRes.candidates[0]?.gates.decision).toBe("accept");
  });

  it("conflict off: противоречие с active не детектируется; default — G3 fail", async () => {
    const activeId = randomUUID();
    // default: активный элемент + конфликтующий кандидат → G3 fail → queue
    const def = asyncStoreOf(new MemoryStore());
    const activeBody = "ВСЕГДА прогоняй миграции перед деплоем";
    await def.addItem({
      item: {
        id: activeId, type: "heuristic", title: "активный урок", scope: "all", tags: [],
        appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body: activeBody,
        bodyHash: hashBody(activeBody), embeddingId: null, scoreGlobal: 0,
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
      provenance: [
        { sourceType: "human", taskId: "seed-act", transcriptHash: "sha256:a", commit: "s", payload: {}, createdAt: NOW.toISOString() },
      ],
      initialDecision: { itemId: activeId, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
    });
    await def.applyTransition(activeId, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    await def.applyTransition(activeId, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
    const conflictLlm = new MockLlm(1536, [["ВСЕГДА", "НИКОГДА"]]);
    const rDef = await admitCandidate(
      ctx(def, CONFIG, candidate({ body: "НИКОГДА не прогоняй миграции перед деплоем" }), conflictLlm),
    );
    expect(rDef.gates.decision).toBe("accept"); // принят, но в queue (противоречие → high)
    expect(rDef.item?.status).toBe("queued");

    // conflict off: то же самое → canary (противоречие не детектировано)
    const off = asyncStoreOf(new MemoryStore());
    const offActiveId = randomUUID();
    await off.addItem({
      item: {
        id: offActiveId, type: "heuristic", title: "активный урок 2", scope: "all", tags: [],
        appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body: activeBody,
        bodyHash: hashBody(activeBody), embeddingId: null, scoreGlobal: 0,
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
      provenance: [
        { sourceType: "human", taskId: "seed-act2", transcriptHash: "sha256:b", commit: "s", payload: {}, createdAt: NOW.toISOString() },
      ],
      initialDecision: { itemId: offActiveId, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
    });
    await off.applyTransition(offActiveId, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    await off.applyTransition(offActiveId, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
    const rOff = await admitCandidate(
      ctx(off, ablation({ conflict: false }), candidate({ body: "НИКОГДА не прогоняй миграции перед деплоем" }), conflictLlm),
    );
    expect(rOff.item?.status).toBe("canary");
    const g3 = rOff.gates.results.find((g) => g.gate === "conflict");
    expect(g3?.detail["ablated"]).toBe(true);
  });
});

// --- negative off в retrieval (PG) ---

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const ABLATION_DB_URL = process.env["EVOLVE_ABLATION_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_ablation_test";

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

describe.skipIf(!pgAvailable)("ablation.negative: negative-элементы не в выдаче (PG)", () => {
  let store: PgStore;

  beforeAll(async () => {
    await freshDb(ABLATION_DB_URL, "evolve_ablation_test");
    store = new PgStore({ connectionString: ABLATION_DB_URL, clock: () => new Date(NOW) });
    for (const [title, body, type] of [
      ["негативный урок миграций", "никогда не удаляй файлы миграций из db/migrations", "negative" as const],
      ["факт о миграциях", "миграции лежат в db/migrations в формате sql", "fact" as const],
    ] as const) {
      const id = randomUUID();
      await store.addItem({
        item: {
          id, type, title, scope: "all", tags: ["migrations"],
          appliesTo: "all", status: "candidate", riskTier: "low", version: 1, body,
          bodyHash: hashBody(body), embeddingId: null, scoreGlobal: 0,
          createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        },
        provenance: [
          { sourceType: "human", taskId: `seed-${type}`, transcriptHash: `sha256:${type}`, commit: "s", payload: {}, createdAt: NOW.toISOString() },
        ],
        initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
      });
      await store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
      await store.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
    }
  }, 60_000);
  afterAll(async () => {
    await store.close();
  });

  it("default: negative в выдаче; negative off — только fact", async () => {
    const def = await retrieve(store.pool, { query: "миграции db/migrations", agentId: "dsh" }, CONFIG, new MockLlm(), NOW);
    const defTypes = def.items.map((r) => r.item.type).sort();
    expect(defTypes).toContain("negative");
    expect(defTypes).toContain("fact");

    const off = await retrieve(
      store.pool,
      { query: "миграции db/migrations", agentId: "dsh" },
      ablation({ negative: false }),
      new MockLlm(),
      NOW,
    );
    expect(off.items.some((r) => r.item.type === "negative")).toBe(false);
    expect(off.items.some((r) => r.item.type === "fact")).toBe(true);
  });
});
