import { describe, expect, it } from "vitest";
import { hashBody } from "../src/domain/hashing.js";
import {
  backfillTaskSuccess,
  knowledgeUsedSchema,
  reviewRecordedSchema,
  TelemetryError,
  taskStartedSchema,
  taskVerifiedSchema,
  telemetryEventSchema,
} from "../src/domain/telemetry.js";
import type { Clock, UsageLogEntry } from "../src/domain/types.js";
import { MemoryStore } from "../src/store/memory-store.js";
import type { StoreSnapshot } from "../src/store/store.js";

const clock: Clock = () => new Date("2026-09-14T10:00:00Z");
const NOW = "2026-09-14T10:00:00Z";

function usageEntry(id: string, taskId: string, taskSuccess: boolean | null): UsageLogEntry {
  return {
    id,
    itemId: "item-x",
    version: 1,
    agentId: "dsh",
    taskId,
    taskSuccess,
    retrievedAt: NOW,
  };
}

describe("схемы событий (ТЗ §11.1, §11.4)", () => {
  it("task_started: валидное проходит, без task_id — нет", () => {
    expect(taskStartedSchema.parse({
      event: "task_started", task_id: "t1", agent_id: "dsh", started_at: NOW,
    }).scope_hints).toEqual([]); // default
    expect(() =>
      taskStartedSchema.parse({ event: "task_started", task_id: "", agent_id: "dsh", started_at: NOW }),
    ).toThrow();
  });

  it("knowledge_used: валидное проходит, version=0 — нет", () => {
    expect(knowledgeUsedSchema.parse({
      event: "knowledge_used", task_id: "t1", item_id: "i1", version: 1, agent_id: "dsh", used_at: NOW,
    }).item_id).toBe("i1");
    expect(() =>
      knowledgeUsedSchema.parse({
        event: "knowledge_used", task_id: "t1", item_id: "i1", version: 0, agent_id: "dsh", used_at: NOW,
      }),
    ).toThrow();
  });

  it("task_verified: verifier_id обязателен (ablation, ТЗ §11.4); human_override опционален", () => {
    const ok = taskVerifiedSchema.parse({
      event: "task_verified", task_id: "t1", agent_id: "dsh", success: true,
      verifier: "tests", verifier_id: "vitest-1", verified_at: NOW,
    });
    expect(ok.human_override).toBeUndefined();
    expect(() =>
      taskVerifiedSchema.parse({
        event: "task_verified", task_id: "t1", agent_id: "dsh", success: true,
        verifier: "tests", verified_at: NOW,
      }),
    ).toThrow();
    expect(() =>
      taskVerifiedSchema.parse({
        event: "task_verified", task_id: "t1", agent_id: "dsh", success: true,
        verifier: "gpt-judge", verifier_id: "x", verified_at: NOW,
      }),
    ).toThrow();
  });

  it("review_recorded: rating 1..5, issues структурированы", () => {
    const r = reviewRecordedSchema.parse({
      event: "review_recorded", task_id: "t1", source: "critic", rating: 4,
      issues: [{ type: "bug", severity: "high", evidence: "src/x.ts:10", lesson_candidate: "уроk" }],
      recorded_at: NOW,
    });
    expect(r.issues).toHaveLength(1);
    expect(() =>
      reviewRecordedSchema.parse({
        event: "review_recorded", task_id: "t1", source: "critic", rating: 6, recorded_at: NOW,
      }),
    ).toThrow();
  });

  it("дискриминированный союз: неизвестный event — ошибка", () => {
    expect(() => telemetryEventSchema.parse({ event: "magic", task_id: "t1" })).toThrow();
  });
});

describe("backfillTaskSuccess (ТЗ §10.3: честная метрика)", () => {
  it("заполняет null-вердикты, оставляет совпадающие", () => {
    const entries = [
      usageEntry("u1", "t1", null),
      usageEntry("u2", "t1", null),
      usageEntry("u3", "t1", true),
      usageEntry("u4", "t2", null),
    ];
    const { updated, unchanged } = backfillTaskSuccess(entries, "t1", true);
    expect(updated).toHaveLength(2);
    expect(unchanged).toBe(1);
    expect(updated.every((u) => u.taskSuccess === true)).toBe(true);
    expect(entries[0]?.taskSuccess).toBeNull(); // входные не мутируют
  });

  it("конфликт вердиктов — TELEMETRY_CONFLICT", () => {
    const entries = [usageEntry("u1", "t1", false)];
    expect(() => backfillTaskSuccess(entries, "t1", true)).toThrowError(TelemetryError);
  });

  it("повторный вызов идемпотентен", () => {
    const entries = [usageEntry("u1", "t1", true)];
    expect(backfillTaskSuccess(entries, "t1", true)).toEqual({ updated: [], unchanged: 1 });
  });
});

describe("MemoryStore: события + backfill + снапшот", () => {
  it("addEvent/events/usageForTask/backfillUsageForTask", () => {
    const s = new MemoryStore(clock);
    s.addUsage(usageEntry("u1", "t1", null));
    s.addUsage(usageEntry("u2", "t2", null));
    s.addEvent({
      event: "task_started", task_id: "t1", agent_id: "dsh", scope_hints: [], started_at: NOW,
    });
    s.addEvent({
      event: "knowledge_used", task_id: "t1", item_id: "item-x", version: 1, agent_id: "dsh", used_at: NOW,
    });
    expect(s.listEvents()).toHaveLength(2);
    expect(s.listEvents({ taskId: "t1" })).toHaveLength(2);
    expect(s.usageForTask("t1")).toHaveLength(1);

    const res = s.backfillUsageForTask("t1", true);
    expect(res).toEqual({ updated: 1, unchanged: 0 });
    expect(s.usageForTask("t1")[0]?.taskSuccess).toBe(true);
    expect(s.usageForTask("t2")[0]?.taskSuccess).toBeNull(); // другая задача не затронута

    // События переживают JSON-цикл (сценарий CLI-файла состояния)
    const restored = MemoryStore.fromSnapshot(JSON.parse(JSON.stringify(s.snapshot())) as StoreSnapshot, clock);
    expect(restored.listEvents({ taskId: "t1" })).toHaveLength(2);
    expect(restored.usageForTask("t1")[0]?.taskSuccess).toBe(true);
  });
});

// smoke: body_hash детерминирован (используется для id usage-записей в CLI)
describe("hashBody детерминированность", () => {
  it("одинаковый вход — одинаковый хеш", () => {
    expect(hashBody("t:i:v")).toBe(hashBody("t:i:v"));
  });
});
