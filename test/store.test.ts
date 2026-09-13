import { describe, expect, it } from "vitest";
import { hashBody } from "../src/domain/hashing.js";
import { InvariantViolationError, InvalidTransitionError, NotFoundError } from "../src/domain/errors.js";
import type { Decision, Item, Provenance } from "../src/domain/types.js";
import { MemoryStore } from "../src/store/memory-store.js";

/** Детерминированные часы: +1 секунда на каждый вызов. */
function makeClock(): { clock: () => Date; ticks: () => number } {
  const t = new Date("2026-09-14T00:00:00Z");
  let n = 0;
  return {
    clock: () => {
      n += 1;
      t.setTime(t.getTime() + 1000);
      return t;
    },
    ticks: () => n,
  };
}

const PROVENANCE: Provenance = {
  sourceType: "success",
  taskId: "task-1",
  transcriptHash: "sha256:abc",
  commit: "deadbeef",
  payload: {},
  createdAt: "2026-09-14T00:00:00Z",
};

function makeItem(id: string, overrides: Partial<Item> = {}): Item {
  const body = overrides.body ?? `тело ${id}`;
  return {
    id,
    type: "fact",
    title: `факт ${id}`,
    scope: "all",
    tags: ["db"],
    appliesTo: "all",
    status: "candidate",
    riskTier: "low",
    version: 1,
    body,
    bodyHash: hashBody(body),
    embeddingId: null,
    scoreGlobal: 0,
    createdAt: "2026-09-14T00:00:00Z",
    updatedAt: "2026-09-14T00:00:00Z",
    ...overrides,
  };
}

function createInput(id: string, item: Item = makeItem(id)): Parameters<MemoryStore["addItem"]>[0] {
  const initialDecision: Omit<Decision, "id" | "createdAt"> = {
    itemId: id,
    version: 1,
    kind: "promote",
    actor: "auto:gate",
    reason: "кандидат прошёл гейты G1–G5",
    evidence: { gates: ["evidence", "dedup", "conflict", "scope", "budget"] },
  };
  return { item, provenance: [PROVENANCE], initialDecision };
}

describe("MemoryStore.addItem (ТЗ §8: единственный путь — кандидат + гейты)", () => {
  it("создаёт item, провенанс и исходный decision", () => {
    const s = new MemoryStore();
    s.addItem(createInput("i1"));
    expect(s.getItem("i1")?.status).toBe("candidate");
    expect(s.provenanceFor("i1")).toHaveLength(1);
    const decisions = s.decisionsFor("i1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.actor).toBe("auto:gate");
  });

  it("прямая запись в active запрещена", () => {
    const s = new MemoryStore();
    expect(() => s.addItem(createInput("i1", makeItem("i1", { status: "active" })))).toThrowError(
      /ТЗ §8/,
    );
  });

  it("body_hash несовпадает с body — ошибка", () => {
    const s = new MemoryStore();
    const item = makeItem("i1");
    expect(() => s.addItem(createInput("i1", { ...item, bodyHash: "bad" }))).toThrowError(InvariantViolationError);
  });

  it("дубликат id — ошибка", () => {
    const s = new MemoryStore();
    s.addItem(createInput("i1"));
    expect(() => s.addItem(createInput("i1"))).toThrowError(/уже существует/);
  });
});

describe("MemoryStore.applyTransition (ТЗ §7.2.3: каждый переход — decision)", () => {
  it("полный путь low-risk: candidate → canary → active, 3 decisions", () => {
    const s = new MemoryStore();
    s.addItem(createInput("i1"));
    s.applyTransition("i1", { to: "canary", kind: "promote", actor: "auto:gate", reason: "risk_tier=low" });
    s.applyTransition("i1", { to: "active", kind: "promote", actor: "auto:canary", reason: "canary-pass: retrievals=3, sr≥baseline−ε" });
    expect(s.getItem("i1")?.status).toBe("active");
    const decisions = s.decisionsFor("i1");
    expect(decisions.map((d) => `${d.kind}:${d.actor}`)).toEqual([
      "promote:auto:gate",
      "promote:auto:gate",
      "promote:auto:canary",
    ]);
  });

  it("полный путь high-risk: candidate → queued → (человек) canary → active", () => {
    const s = new MemoryStore();
    s.addItem(createInput("i2", makeItem("i2", { riskTier: "high", type: "negative" })));
    s.applyTransition("i2", { to: "queued", kind: "promote", actor: "auto:gate", reason: "risk_tier=high" });
    expect(() =>
      s.applyTransition("i2", { to: "canary", kind: "promote", actor: "auto:gate", reason: "авто не может" }),
    ).toThrowError(InvalidTransitionError);
    s.applyTransition("i2", { to: "canary", kind: "promote", actor: "human", reason: "принято в недельном окне" });
    expect(s.getItem("i2")?.status).toBe("canary");
  });

  it("деградация и rollback: active → deprecated → active (human)", () => {
    const s = new MemoryStore();
    s.addItem(createInput("i3"));
    s.applyTransition("i3", { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    s.applyTransition("i3", { to: "active", kind: "promote", actor: "auto:canary", reason: "pass" });
    s.applyTransition("i3", { to: "deprecated", kind: "demote", actor: "auto:degradation", reason: "21 день без usage" });
    s.applyTransition("i3", { to: "active", kind: "promote", actor: "human", reason: "rollback: вернули авто-решение (ТЗ §12.1)" });
    expect(s.getItem("i3")?.status).toBe("active");
    expect(s.decisionsFor("i3")).toHaveLength(5);
  });

  it("архивация: deprecated → archived с обязательной причиной; archived — терминален", () => {
    const s = new MemoryStore();
    s.addItem(createInput("i4"));
    s.applyTransition("i4", { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    s.applyTransition("i4", { to: "active", kind: "promote", actor: "auto:canary", reason: "pass" });
    s.applyTransition("i4", { to: "deprecated", kind: "demote", actor: "auto:degradation", reason: "x" });
    expect(() => s.applyTransition("i4", { to: "archived", kind: "archive", actor: "auto:degradation", reason: "30 дней" })).toThrowError(
      /archived_reason/,
    );
    s.applyTransition("i4", { to: "archived", kind: "archive", actor: "auto:degradation", reason: "30 дней", archivedReason: "score не восстановился" });
    expect(s.getItem("i4")?.archivedReason).toBe("score не восстановился");
    expect(() => s.applyTransition("i4", { to: "active", kind: "promote", actor: "human", reason: "оживить" })).toThrowError(
      /терминальный/,
    );
  });

  it("неизвестный item — NotFoundError", () => {
    const s = new MemoryStore();
    expect(() => s.applyTransition("nope", { to: "canary", kind: "promote", actor: "auto:gate", reason: "x" })).toThrowError(
      NotFoundError,
    );
  });
});

describe("MemoryStore.addVersion (ТЗ §7.2.2: тело версии иммутабельно)", () => {
  it("новая версия: hash пересчитан, старая помечена superseded, decision approve_edit", () => {
    const s = new MemoryStore();
    s.addItem(createInput("i1"));
    const updated = s.addVersion("i1", "тело v2", {
      kind: "approve_edit",
      actor: "human",
      reason: "принято с правкой",
      evidence: { diff: "1 строка" },
    });
    expect(updated.version).toBe(2);
    expect(updated.bodyHash).toBe(hashBody("тело v2"));
    const versions = s.itemVersions("i1");
    expect(versions).toHaveLength(2);
    expect(versions[0]?.body).toBe("тело i1"); // старая версия не мутирует
    expect(versions[0]?.supersededBy).toBe(versions[1]?.id);
    expect(versions[1]?.supersededBy).toBeNull();
    const d = s.decisionsFor("i1").at(-1);
    expect(d?.kind).toBe("approve_edit");
    expect(d?.version).toBe(2);
  });

  it("kind отличный от approve_edit — ошибка", () => {
    const s = new MemoryStore();
    s.addItem(createInput("i1"));
    expect(() => s.addVersion("i1", "x", { kind: "promote", actor: "human", reason: "x", evidence: {} })).toThrowError(
      /approve_edit/,
    );
  });
});

describe("MemoryStore.listItems", () => {
  it("фильтрует по status и type; порядок детерминирован (createdAt, id)", () => {
    const s = new MemoryStore(makeClock().clock);
    s.addItem(createInput("a"));
    s.addItem(createInput("b", makeItem("b", { type: "skill" })));
    s.applyTransition("a", { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    expect(s.listItems().map((i) => i.id)).toEqual(["a", "b"]);
    expect(s.listItems({ status: "canary" }).map((i) => i.id)).toEqual(["a"]);
    expect(s.listItems({ type: "skill" }).map((i) => i.id)).toEqual(["b"]);
  });
});
