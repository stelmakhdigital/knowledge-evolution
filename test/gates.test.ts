import { describe, expect, it } from "vitest";
import { loadConfig, type EvolveConfig } from "../src/config/config.js";
import { hashBody } from "../src/domain/hashing.js";
import type { Candidate, Clock, GateResult, Item } from "../src/domain/types.js";
import {
  admitCandidate,
  gateBudget,
  gateConflict,
  gateDedup,
  gateEvidence,
  riskTierOf,
  type GateContext,
} from "../src/gates/gates.js";
import { MockLlm } from "../src/llm/client.js";
import { MemoryStore } from "../src/store/memory-store.js";

/** Реальный config.yaml как эталон порогов; для сценариев лимитов — клон с изменёнными бюджетами. */
const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);

const clock: Clock = () => new Date("2026-09-14T12:00:00Z");

function withBudget(overrides: Partial<EvolveConfig["budget"]>): EvolveConfig {
  return { ...CONFIG, budget: { ...CONFIG.budget, ...overrides } };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    type: "fact",
    title: "факт",
    scope: "src/db/**",
    tags: ["db"],
    appliesTo: "all",
    body: "миграции лежат в db/migrations, формат foo",
    provenance: {
      sourceType: "success",
      taskId: "task-1",
      transcriptHash: "sha256:t1",
      commit: "deadbeef",
      payload: { verifier: "tests" },
      createdAt: "2026-09-14T12:00:00Z",
    },
    ...overrides,
  };
}

function makeCtx(
  candidate: Candidate,
  opts: { store?: MemoryStore; llm?: MockLlm; config?: EvolveConfig; agentId?: string; candidateRef?: string } = {},
): GateContext {
  return {
    candidate,
    candidateRef: opts.candidateRef ?? "cand-1",
    store: opts.store ?? new MemoryStore(clock),
    config: opts.config ?? CONFIG,
    llm: opts.llm ?? new MockLlm(),
    clock,
    agentId: opts.agentId ?? "dsh",
  };
}

/** Сид item'а в заданном статусе (корректным путём стейт-машины). */
function seedItem(store: MemoryStore, id: string, body: string, status: Item["status"]): Item {
  store.addItem({
    item: {
      id,
      type: "fact",
      title: id,
      scope: "src/x",
      tags: [],
      appliesTo: "all",
      status: "candidate",
      riskTier: "low",
      version: 1,
      body,
      bodyHash: hashBody(body),
      embeddingId: null,
      scoreGlobal: 0,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    },
    provenance: [{
      sourceType: "human",
      taskId: "seed",
      transcriptHash: "sha256:seed",
      commit: "seed0000",
      payload: {},
      createdAt: "2026-09-01T00:00:00Z",
    }],
    initialDecision: { itemId: id, version: 1, kind: "promote", actor: "human", reason: "seed", evidence: {} },
  });
  if (status === "active") {
    store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "seed" });
    store.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
  } else if (status === "queued") {
    store.applyTransition(id, { to: "queued", kind: "promote", actor: "auto:gate", reason: "seed high" });
  }
  return store.getItem(id) as Item;
}

describe("G1 evidence (ТЗ: task_id + верификация, не self-reported)", () => {
  it("pass: есть taskId + transcriptHash + verifier", () => {
    const r = gateEvidence(makeCtx(makeCandidate()));
    expect(r.outcome).toBe("pass");
    expect(r.detail["verifier"]).toBe("tests");
    expect(r.detail["agent_id"]).toBe("dsh");
  });

  it("fail: self-reported (нет verifier)", () => {
    const c = makeCandidate();
    const r = gateEvidence(makeCtx({ ...c, provenance: { ...c.provenance, payload: {} } }));
    expect(r.outcome).toBe("fail");
    expect(String(r.detail["reason"])).toMatch(/self-reported/);
  });

  it("fail: нет taskId", () => {
    const c = makeCandidate();
    const r = gateEvidence(makeCtx({ ...c, provenance: { ...c.provenance, taskId: "" } }));
    expect(r.outcome).toBe("fail");
  });
});

describe("G2 dedup (cos_sim ≥ θ_dedup → merge-предложение)", () => {
  it("pass: тело уникально относительно базы", () => {
    const store = new MemoryStore(clock);
    seedItem(store, "i1", "совсем другое утверждение про кеш и пул соединений");
    const r = gateDedup(makeCtx(makeCandidate(), { store }));
    expect(r.outcome).toBe("pass");
    expect(Number(r.detail["max_similarity"] ?? 0)).toBeLessThan(CONFIG.theta_dedup);
  });

  it("fail: тело идентично существующему item → merge", () => {
    const store = new MemoryStore(clock);
    seedItem(store, "i1", "миграции лежат в db/migrations, формат foo");
    const r = gateDedup(makeCtx(makeCandidate(), { store }));
    expect(r.outcome).toBe("fail");
    expect(r.detail["merge_item_id"]).toBe("i1");
    expect(Number(r.detail["similarity"] ?? 0)).toBeGreaterThanOrEqual(CONFIG.theta_dedup);
  });
});

describe("G4 scope (широта → risk_tier, ТЗ §8)", () => {
  const cases = [
    { cand: makeCandidate(), expected: "low" }, // узкий glob
    { cand: makeCandidate({ scope: "all" }), expected: "high" },
    { cand: makeCandidate({ type: "negative", scope: "src/x" }), expected: "high" }, // всегда high
    { cand: makeCandidate({ type: "tool_proposal", scope: "src/x" }), expected: "high" }, // всегда high
  ] as const;

  for (const { cand, expected } of cases) {
    it(`type=${cand.type}, scope='${cand.scope}' → ${expected}`, () => {
      expect(riskTierOf(cand)).toBe(expected);
    });
  }
});

describe("G5 budget (ТЗ: active ≤ 300; queue/нед ≤ 10; кандидатов/агент/день ≤ 5)", () => {
  it("fail: active достиг cap", () => {
    const store = new MemoryStore(clock);
    seedItem(store, "a1", "первый активный элемент про базу данных", "active");
    seedItem(store, "a2", "второй активный элемент про тестирование кода", "active");
    const r = gateBudget(makeCtx(makeCandidate(), { store, config: withBudget({ active_max: 2 }) }));
    expect(r.outcome).toBe("fail");
    expect(String(r.detail["reason"])).toMatch(/active=2 ≥ cap=2/);
  });

  it("fail: очередь переполнена", () => {
    const store = new MemoryStore(clock);
    seedItem(store, "q1", "ожидающий в очереди элемент про миграции", "queued");
    const r = gateBudget(makeCtx(makeCandidate(), { store, config: withBudget({ queue_per_week_max: 1 }) }));
    expect(r.outcome).toBe("fail");
    expect(String(r.detail["reason"])).toMatch(/queued=1/);
  });

  it("fail: дневной лимит кандидатов на агента (с учётом текущего кандидата)", () => {
    const store = new MemoryStore(clock);
    // Симуляция: G1 уже записан для текущего кандидата + 1 прошлый кандидат того же агента за сегодня.
    const preSeed: GateResult = {
      id: "g-1",
      candidateId: "cand-0",
      gate: "evidence",
      outcome: "pass",
      detail: { agent_id: "dsh", verifier: "tests" },
      createdAt: "2026-09-14T09:00:00.000Z",
    };
    store.addGateResult(preSeed);
    const ctx = makeCtx(makeCandidate(), { store, config: withBudget({ candidates_per_agent_per_day_max: 1 }) });
    // В конвейере G1 текущего кандидата записывается до G5:
    ctx.store.addGateResult({ ...preSeed, id: "g-2", candidateId: "cand-1", detail: { agent_id: "dsh", verifier: "tests" } });
    const r = gateBudget(ctx);
    expect(r.outcome).toBe("fail");
    expect(String(r.detail["reason"])).toMatch(/кандидатов агента dsh сегодня: 2 > 1|≥ 1|2 ≥ 1/);
  });

  it("pass: лимиты не превышены (5-й кандидат из лимита 5 проходит)", () => {
    const store = new MemoryStore(clock);
    for (let i = 0; i < 5; i += 1) {
      store.addGateResult({
        id: `g-${i}`,
        candidateId: `cand-${i}`,
        gate: "evidence",
        outcome: "pass",
        detail: { agent_id: "dsh", verifier: "tests" },
        createdAt: `2026-09-14T0${i}:00:00.000Z`,
      });
    }
    const r = gateBudget(makeCtx(makeCandidate(), { store })); // 5 ≤ 5 → проходит (6-й уже не пройдёт)
    expect(r.outcome).toBe("pass");
    expect(r.detail["candidates_today"]).toBe(5);
  });
});

describe("G3 conflict (LLM-детектор → contradictions.open)", () => {
  it("pass: нет активных элементов", async () => {
    const ctx = makeCtx(makeCandidate());
    const item = seedItem(new MemoryStore(clock), "x", "пустая база", "candidate");
    const r = await gateConflict(item, ctx);
    expect(r.outcome).toBe("pass");
    expect(r.detail["active_checked"]).toBe(0);
  });

  it("fail: противоречие с active → contradiction создана", async () => {
    const store = new MemoryStore(clock);
    seedItem(store, "active-1", "всегда отключай кеш в продакшене", "active");
    const llm = new MockLlm(16, [["отключай кеш", "включай кеш"]]);
    const ctx = makeCtx(makeCandidate({ body: "всегда включай кеш для производительности" }), { store, llm });
    const item = store.getItem("active-1") as Item;
    // Кандидат как будущий item:
    const candItem = seedItem(store, "cand-1", "всегда включай кеш для производительности", "candidate");
    const r = await gateConflict(candItem, ctx);
    expect(r.outcome).toBe("fail");
    const contradictions = store.listContradictions({ status: "open" });
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.id).toBe(r.detail["contradiction_id"]);
    expect(contradictions[0]?.itemAId).toBe("cand-1");
    expect(contradictions[0]?.itemBId).toBe("active-1");
    expect(item).not.toBeNull();
  });
});

describe("admitCandidate (полный конвейер ТЗ §9)", () => {
  it("low risk: candidate → canary; 5 gate_results и 2 decisions", async () => {
    const store = new MemoryStore(clock);
    const ctx = makeCtx(makeCandidate({ scope: "src/db/**" }), { store });
    const res = await admitCandidate(ctx);
    expect(res.gates.decision).toBe("accept");
    expect(res.item?.status).toBe("canary");
    expect(res.gates.riskTier).toBe("low");
    expect(store.gateResultsFor("cand-1").map((g) => g.gate)).toEqual([
      "evidence", "dedup", "scope", "budget", "conflict",
    ]);
    expect(store.decisionsFor(res.item?.id ?? "")).toHaveLength(2); // создание + promote в canary
  });

  it("high risk (negative): → queued (человек)", async () => {
    const store = new MemoryStore(clock);
    const ctx = makeCtx(makeCandidate({ type: "negative", body: "никогда не удаляй миграции" }), { store });
    const res = await admitCandidate(ctx);
    expect(res.item?.status).toBe("queued");
    expect(res.gates.riskTier).toBe("high");
  });

  it("reject на G1: item не создаётся", async () => {
    const store = new MemoryStore(clock);
    const c = makeCandidate();
    const ctx = makeCtx({ ...c, provenance: { ...c.provenance, payload: {} } }, { store });
    const res = await admitCandidate(ctx);
    expect(res.gates.decision).toBe("reject");
    expect(res.item).toBeUndefined();
    expect(store.listItems()).toHaveLength(0);
    expect(store.gateResultsFor("cand-1")).toHaveLength(1);
  });

  it("merge: дубль существующего item", async () => {
    const store = new MemoryStore(clock);
    seedItem(store, "i1", "миграции лежат в db/migrations, формат foo", "active");
    const ctx = makeCtx(makeCandidate(), { store });
    const res = await admitCandidate(ctx);
    expect(res.gates.decision).toBe("merge");
    expect(res.gates.mergeItemId).toBe("i1");
    expect(store.listItems()).toHaveLength(1);
  });

  it("reject на G5: cap active исчерпан", async () => {
    const store = new MemoryStore(clock);
    seedItem(store, "a1", "первый активный элемент про базу данных", "active");
    const ctx = makeCtx(makeCandidate({ body: "совсем новое утверждение про логи" }), {
      store,
      config: withBudget({ active_max: 1 }),
    });
    const res = await admitCandidate(ctx);
    expect(res.gates.decision).toBe("reject");
    expect(store.listItems()).toHaveLength(1);
  });

  it("противоречие поднимает risk до high: low-risk кандидат → queued + open contradiction", async () => {
    const store = new MemoryStore(clock);
    seedItem(store, "active-1", "всегда отключай кеш в продакшене", "active");
    const llm = new MockLlm(16, [["отключай кеш", "включай кеш"]]);
    const ctx = makeCtx(
      makeCandidate({ body: "всегда включай кеш для производительности" }),
      { store, llm },
    );
    const res = await admitCandidate(ctx);
    expect(res.item?.status).toBe("queued");
    expect(res.gates.riskTier).toBe("high");
    expect(res.gates.contradictionId).toBeDefined();
    expect(store.listContradictions({ status: "open" })).toHaveLength(1);
  });
});
