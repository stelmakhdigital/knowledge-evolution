import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { hashBody } from "../src/domain/hashing.js";
import type { Item } from "../src/domain/types.js";
import { buildQueueCard, listQueueCards } from "../src/queue/queue.js";
import { MemoryStore } from "../src/store/memory-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");

function seedQueued(id: string, body: string, tags: readonly string[], queuedAt: string): MemoryStore {
  // Часы хранилища фиксируют момент перехода в queued: updatedAt item = этот момент.
  const s = new MemoryStore(() => new Date(queuedAt));
  s.addItem({
    item: {
      id,
      type: "negative",
      title: id,
      scope: "all",
      tags: [...tags],
      appliesTo: "all",
      status: "candidate",
      riskTier: "high",
      version: 1,
      body,
      bodyHash: hashBody(body),
      embeddingId: null,
      scoreGlobal: 0,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: queuedAt,
    },
    provenance: [{
      sourceType: "review",
      taskId: `task-${id}`,
      transcriptHash: `sha256:${id}`,
      commit: "commit-x",
      payload: { verifier: "human" },
      createdAt: queuedAt,
    }],
    initialDecision: {
      itemId: id,
      version: 1,
      kind: "promote",
      actor: "auto:gate",
      reason: "risk_tier=high",
      evidence: { candidate_ref: `cand-${id}` },
    },
  });
  s.applyTransition(id, { to: "queued", kind: "promote", actor: "auto:gate", reason: "high" });
  return s;
}

describe("buildQueueCard (ТЗ §12.1)", () => {
  it("возраст и stale по порогу алерта (queue_card_max_days=14)", () => {
    const fresh = seedQueued("fresh", "свежая карточка о секретах в логах", ["secrets"], "2026-09-10T12:00:00Z");
    const card = buildQueueCard(fresh.getItem("fresh") as Item, fresh, CONFIG, NOW);
    expect(card.daysInQueue).toBe(4);
    expect(card.stale).toBe(false);

    const old = seedQueued("old", "старая карточка о секретах в логах", ["secrets"], "2026-08-01T12:00:00Z");
    const cardOld = buildQueueCard(old.getItem("old") as Item, old, CONFIG, NOW);
    expect(cardOld.daysInQueue).toBeGreaterThan(CONFIG.alerts.queue_card_max_days);
    expect(cardOld.stale).toBe(true);
  });

  it("цена бездействия: общие теги увеличивают cost", () => {
    const s = seedQueued("a", "карточка о миграциях базы данных", ["db"], "2026-09-13T12:00:00Z");
    const s2 = seedQueued("b", "вторая карточка о миграциях базы", ["db", "migrations"], "2026-09-13T12:00:00Z");
    // Склеиваем в одно хранилище (как CLI: один state-файл)
    const merged = MemoryStore.fromSnapshot({
      items: [...s.snapshot().items, ...s2.snapshot().items],
      versions: { ...s.snapshot().versions, ...s2.snapshot().versions },
      provenance: { ...s.snapshot().provenance, ...s2.snapshot().provenance },
      decisions: { ...s.snapshot().decisions, ...s2.snapshot().decisions },
      gateResults: { ...s.snapshot().gateResults, ...s2.snapshot().gateResults },
      usage: { ...s.snapshot().usage, ...s2.snapshot().usage },
      events: [...s.snapshot().events, ...s2.snapshot().events],
      contradictions: [],
      profiles: {},
    });
    const cardA = buildQueueCard(merged.getItem("a") as Item, merged, CONFIG, NOW);
    expect(cardA.costOfInaction).toBe(2); // a + b (общий тег db)

    const alone = seedQueued("solo", "одинокая карточка про уникальный тег", ["unique-tag"], "2026-09-13T12:00:00Z");
    expect(buildQueueCard(alone.getItem("solo") as Item, alone, CONFIG, NOW).costOfInaction).toBe(1);
  });

  it("провенанс и gate_results доступны карточке", () => {
    const s = seedQueued("p", "карточка с провенансом задачи", ["x"], "2026-09-13T12:00:00Z");
    s.addGateResult({
      id: "g1",
      candidateId: "cand-p",
      gate: "scope",
      outcome: "pass",
      detail: { risk_tier: "high" },
      createdAt: "2026-09-13T12:00:00Z",
    });
    const card = buildQueueCard(s.getItem("p") as Item, s, CONFIG, NOW);
    expect(card.provenanceRefs[0]?.taskId).toBe("task-p");
    expect(card.gateResults).toHaveLength(1);
  });
});

describe("listQueueCards", () => {
  it("сортировка: цена бездействия (убыв), затем старейшие", () => {
    const s = seedQueued("new", "новая карточка общего тега", ["common"], "2026-09-14T00:00:00Z");
    const s2 = seedQueued("old2", "старая карточка общего тега", ["common"], "2026-09-01T00:00:00Z");
    const merged = MemoryStore.fromSnapshot({
      items: [...s.snapshot().items, ...s2.snapshot().items],
      versions: { ...s.snapshot().versions, ...s2.snapshot().versions },
      provenance: { ...s.snapshot().provenance, ...s2.snapshot().provenance },
      decisions: { ...s.snapshot().decisions, ...s2.snapshot().decisions },
      gateResults: { ...s.snapshot().gateResults, ...s2.snapshot().gateResults },
      usage: { ...s.snapshot().usage, ...s2.snapshot().usage },
      events: [...s.snapshot().events, ...s2.snapshot().events],
      contradictions: [],
      profiles: {},
    });
    const cards = listQueueCards(merged, CONFIG, NOW);
    expect(cards.map((c) => c.item.id)).toEqual(["old2", "new"]); // равный cost → старая первая
    expect(cards.every((c) => c.item.status === "queued")).toBe(true);
  });
});

describe("queue accept-edit (approve_edit + canary)", () => {
  it("правка тела: v2 + superseded + два decisions, статус canary", () => {
    const s = seedQueued("e", "первоначальное тело правки", ["t"], "2026-09-13T12:00:00Z");
    const updated = s.addVersion("e", "исправленное тело после правки", {
      kind: "approve_edit",
      actor: "human",
      reason: "сужили scope",
      evidence: { source: "queue" },
    });
    expect(updated.version).toBe(2);
    const after = s.applyTransition("e", {
      to: "canary",
      kind: "promote",
      actor: "human",
      reason: "принято с правкой",
      evidence: { version: 2 },
    });
    expect(after.status).toBe("canary");
    const versions = s.itemVersions("e");
    expect(versions[0]?.supersededBy).toBe(versions[1]?.id);
    expect(s.decisionsFor("e").map((d) => d.kind)).toEqual(["promote", "promote", "approve_edit", "promote"]);
  });
});
