import { describe, expect, it } from "vitest";
import { hashBody } from "../src/domain/hashing.js";
import type { Clock, Item } from "../src/domain/types.js";
import { MemoryStore } from "../src/store/memory-store.js";
import type { StoreSnapshot } from "../src/store/store.js";

const clock: Clock = () => new Date("2026-09-14T08:00:00Z");

function seed(id: string, body: string, status: Item["status"]): MemoryStore {
  const s = new MemoryStore(clock);
  s.addItem({
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
    s.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "seed" });
    s.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
  }
  return s;
}

describe("MemoryStore snapshot round-trip", () => {
  it("полное состояние переживает JSON-сериализацию (сценарий CLI-файла)", () => {
    const s = seed("i1", "первый элемент про миграции базы данных", "active");
    const s2 = seed("i2", "второй элемент про тестирование", "candidate");
    // Обогащаем: версия, contradiction, gate result, профиль, usage.
    s2.addVersion("i2", "правка тела v2", { kind: "approve_edit", actor: "human", reason: "правка", evidence: {} });
    s2.addContradiction({
      id: "c1",
      itemAId: "i1",
      itemBId: "i2",
      severity: "high",
      status: "open",
      resolvedBy: null,
      createdAt: "2026-09-14T08:00:00Z",
    });
    s2.addGateResult({
      id: "g1",
      candidateId: "cand-x",
      gate: "evidence",
      outcome: "pass",
      detail: { agent_id: "dsh", verifier: "tests" },
      createdAt: "2026-09-14T08:00:00Z",
    });
    s2.upsertAgentProfile({
      agentId: "dsh",
      contextBudget: 4000,
      retrievalTopK: 5,
      format: "markdown",
      createdAt: "2026-09-01T00:00:00Z",
    });
    s2.addUsage({
      id: "u1",
      itemId: "i1",
      version: 1,
      agentId: "dsh",
      taskId: "task-9",
      taskSuccess: true,
      retrievedAt: "2026-09-14T07:00:00Z",
    });

    // Склеиваем состояния в один store (как в CLI: один файл состояния).
    const merged = MemoryStore.fromSnapshot(mergeSnapshots(s.snapshot(), s2.snapshot()), clock);

    // JSON-цикл — имитация записи в .evolve/state.json и чтения обратно.
    const json = JSON.stringify(merged.snapshot());
    const restored = MemoryStore.fromSnapshot(JSON.parse(json) as StoreSnapshot, clock);

    expect(restored.listItems().map((i) => i.id).sort()).toEqual(["i1", "i2"]);
    expect(restored.getItem("i1")?.status).toBe("active");
    expect(restored.getItem("i2")?.version).toBe(2);
    expect(restored.itemVersions("i2")).toHaveLength(2);
    expect(restored.decisionsFor("i1")).toHaveLength(3); // seed + canary + active
    expect(restored.provenanceFor("i1")).toHaveLength(1);
    expect(restored.listContradictions({ status: "open" })).toHaveLength(1);
    expect(restored.gateResultsFor("cand-x")).toHaveLength(1);
    expect(restored.getAgentProfile("dsh")?.retrievalTopK).toBe(5);
    expect(restored.usageFor("i1")).toHaveLength(1);

    // Восстановленный store продолжает работать: переход возможен и пишет decision.
    restored.applyTransition("i2", { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    expect(restored.getItem("i2")?.status).toBe("canary");
  });

  it("пустой снапшот восстанавливается как пустое хранилище", () => {
    const restored = MemoryStore.fromSnapshot(JSON.parse("{}") as StoreSnapshot, clock);
    expect(restored.listItems()).toHaveLength(0);
  });
});

/** Точечное склеивание двух снапшотов (только для теста). */
function mergeSnapshots(a: StoreSnapshot, b: StoreSnapshot): StoreSnapshot {
  const merge = <T,>(x: Readonly<Record<string, readonly T[]>>, y: Readonly<Record<string, readonly T[]>>): Record<string, T[]> =>
    Object.fromEntries(
      [...Object.entries(x), ...Object.entries(y)].map(([k, v]) => [k, [...(mergedMap(k, x, y))]]),
    );
  function mergedMap<K extends string>(key: K, xs: Readonly<Record<string, readonly T[]>>, ys: Readonly<Record<string, readonly T[]>>): T[] {
    return [...(xs[key] ?? []), ...(ys[key] ?? [])];
  }
  return {
    items: [...a.items, ...b.items],
    versions: merge(a.versions, b.versions),
    provenance: merge(a.provenance, b.provenance),
    decisions: merge(a.decisions, b.decisions),
    gateResults: merge(a.gateResults, b.gateResults),
    usage: merge(a.usage, b.usage),
    contradictions: [...a.contradictions, ...b.contradictions],
    profiles: { ...a.profiles, ...b.profiles },
  };
}
