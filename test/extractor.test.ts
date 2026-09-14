import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { hashBody } from "../src/domain/hashing.js";
import {
  buildExtractionPrompt,
  ExtractorError,
  JsonExtractor,
  MockExtractor,
  toDomainCandidate,
  type ExtractionInput,
} from "../src/extractor/extractor.js";
import { admitCandidate, type GateContext } from "../src/gates/gates.js";
import { MockLlm } from "../src/llm/client.js";
import { MockTextLlm } from "../src/llm/text-client.js";
import { MemoryStore } from "../src/store/memory-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);

function makeInput(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    taskId: "task-99",
    agentId: "dsh",
    transcript: "УНИКАЛЬНЫЙ_ТРАНСКРИПТ_ЗАДАЧИ",
    verifier: "tests",
    verifierId: "vitest",
    scopeHints: ["db"],
    ...overrides,
  };
}

describe("buildExtractionPrompt (ТЗ §16: схемы + few-shot)", () => {
  it("содержит схему, few-shot, контекст задачи и транскрипт", () => {
    const p = buildExtractionPrompt(makeInput({ taskId: "t-77", transcript: "УНИКАЛЬНЫЙ_МАРКЕР_ЗАДАЧИ" }));
    expect(p).toContain('"candidates"');
    expect(p).toContain("heuristic");
    expect(p).toContain("Примеры:");
    expect(p).toContain("task_id=t-77");
    expect(p).toContain("УНИКАЛЬНЫЙ_МАРКЕР_ЗАДАЧИ");
    expect(p).toContain("≤ 5 кандидатов");
  });
});

describe("JsonExtractor (LLM → zod-схема)", () => {
  const goodJson = JSON.stringify({
    candidates: [
      {
        type: "heuristic",
        title: "проеб migration-тест",
        scope: "db/migrations",
        tags: ["db"],
        applies_to: "all",
        body: "Сначала прогоняй migration-тест, потом меняй схему.",
        confidence: 0.8,
      },
    ],
    notes: "",
  });

  it("валидный JSON (в т.ч. в ```-обёртке) → кандидаты", async () => {
    const plain = new JsonExtractor(new MockTextLlm([["УНИКАЛЬНЫЙ", goodJson]]));
    const res = await plain.extract(makeInput());
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]?.type).toBe("heuristic");

    const fenced = new JsonExtractor(new MockTextLlm([["УНИКАЛЬНЫЙ", "```json\n" + goodJson + "\n```"]]));
    const res2 = await fenced.extract(makeInput());
    expect(res2.candidates).toHaveLength(1);
  });

  it("не-JSON — EXTRACTOR_INVALID_JSON", async () => {
    const ex = new JsonExtractor(new MockTextLlm([["УНИКАЛЬНЫЙ", "нет, я думаю, что…"]]));
    await expect(ex.extract(makeInput())).rejects.toThrowError(ExtractorError);
    await expect(ex.extract(makeInput())).rejects.toThrow(/EXTRACTOR|не-JSON|JSON-объект/);
  });

  it("нарушение схемы (тип/короткое тело) — EXTRACTOR_SCHEMA", async () => {
    const bad = JSON.stringify({
      candidates: [{ type: "magic", title: "x", scope: "all", body: "к" }],
      notes: "",
    });
    const ex = new JsonExtractor(new MockTextLlm([["УНИКАЛЬНЫЙ", bad]]));
    const err = await ex.extract(makeInput()).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractorError);
    expect((err as ExtractorError).code).toBe("EXTRACTOR_SCHEMA");
  });

  it("более 5 кандидатов → обрезка до 5", async () => {
    const many = JSON.stringify({
      candidates: Array.from({ length: 7 }, (_, i) => ({
        type: "fact",
        title: `факт номер ${i + 1}`,
        scope: "all",
        body: `тело факта номер ${i + 1} длиннее десяти символов`,
      })),
      notes: "",
    });
    const ex = new JsonExtractor(new MockTextLlm([["УНИКАЛЬНЫЙ", many]]));
    const res = await ex.extract(makeInput());
    expect(res.candidates).toHaveLength(5);
  });
});

describe("MockExtractor (детерминированный мок-LLM для M1)", () => {
  it("извлекает LESSON-строки в кандидаты", async () => {
    const transcript = [
      "шаг 1: открыл файл",
      "LESSON: heuristic:db/migrations|сначала прогоняй migration-тест, потом меняй схему|db,migrations",
      "шаг 2: починил",
      "LESSON: negative:all|никогда не удаляй миграцию|secrets",
    ].join("\n");
    const res = await new MockExtractor().extract(makeInput({ transcript }));
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates[0]?.type).toBe("heuristic");
    expect(res.candidates[0]?.scope).toBe("db/migrations");
    expect(res.candidates[0]?.tags).toEqual(["db", "migrations"]);
    expect(res.candidates[1]?.type).toBe("negative");
  });

  it("без LESSON-строк — пусто, с заметками", async () => {
    const res = await new MockExtractor().extract(makeInput({ transcript: "просто текст без знаний" }));
    expect(res.candidates).toHaveLength(0);
  });

  it("невалидная строка — в notes, не в кандидаты", async () => {
    const res = await new MockExtractor().extract(
      makeInput({ transcript: "LESSON: :|пустой scope|tags" }),
    );
    expect(res.candidates).toHaveLength(0);
    expect(res.notes).toMatch(/невалидн/);
  });

  it("лимит 5 кандидатов", async () => {
    const transcript = Array.from({ length: 7 }, (_, i) =>
      `LESSON: fact:all|факт номер ${i + 1} для лимита|`,
    ).join("\n");
    const res = await new MockExtractor().extract(makeInput({ transcript }));
    expect(res.candidates).toHaveLength(5);
  });
});

describe("toDomainCandidate + пайплайн (экстрактор → гейты, ТЗ §8)", () => {
  it("извлечённые кандидаты проходят конвейер с провенансом задачи", async () => {
    const store = new MemoryStore(() => new Date("2026-09-14T09:00:00Z"));
    const input = makeInput({
      taskId: "task-99",
      transcript: [
        "LESSON: fact:src/db/**|миграции лежат в db/migrations, формат foo|db",
        "LESSON: negative:all|никогда не удаляй миграцию|",
      ].join("\n"),
    });
    const { candidates, notes } = await new MockExtractor().extract(input);
    expect(notes).toBe("");
    const transcriptHash = `sha256:${hashBody(input.transcript)}`;

    const toCandidate = (ext: (typeof candidates)[number], ref: string): Candidate => {
      const base = toDomainCandidate(ext, {
        sourceType: "success",
        taskId: input.taskId,
        transcriptHash,
        commit: "abc123",
        payload: { verifier: "tests", verifier_id: "vitest" },
        createdAt: "2026-09-14T09:00:00Z",
      });
      void ref;
      return base;
    };

    const makeCtx = (candidate: Candidate, ref: string): GateContext => ({
      candidate,
      candidateRef: ref,
      store,
      config: CONFIG,
      llm: new MockLlm(),
      clock: () => new Date("2026-09-14T09:00:00Z"),
      agentId: input.agentId,
    });

    const r0 = await admitCandidate(makeCtx(toCandidate(candidates[0]!, "ext-0"), "ext-0"));
    expect(r0.gates.decision).toBe("accept");
    expect(r0.item?.status).toBe("canary"); // fact + узкий scope → low

    const r1 = await admitCandidate(makeCtx(toCandidate(candidates[1]!, "ext-1"), "ext-1"));
    expect(r1.item?.status).toBe("queued"); // negative → high

    // Провенанс сохранён в базе (white-box, ТЗ §7.2.7)
    const prov = store.provenanceFor(r1.item?.id ?? "");
    expect(prov[0]?.transcriptHash).toBe(transcriptHash);
    expect(prov[0]?.taskId).toBe("task-99");
  });
});
