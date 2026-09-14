import { z } from "zod";
import { EvolveError } from "../domain/errors.js";
import type { Candidate, ItemType } from "../domain/types.js";
import type { TextLlmClient } from "../llm/text-client.js";

/**
 * Экстрактор знаний из завершённых задач (ТЗ §15 M1, §8, §16).
 * Выход — структурированные кандидаты (схема ниже), которые идут в конвейер
 * гейтов как обычные кандидаты (ТЗ §8: единственный путь — кандидат + гейты).
 * Митигация риска «низкое качество экстрактора» (ТЗ §16): схемы + few-shot в промпте.
 */

export class ExtractorError extends EvolveError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ExtractorError";
  }
}

// --- контракт выхода экстрактора ---

export const extractedCandidateSchema = z.object({
  type: z.enum(["skill", "heuristic", "negative", "fact", "tool_proposal"]),
  title: z.string().min(3),
  scope: z.string().min(1), // модуль/glob/'all'
  tags: z.array(z.string()).default([]),
  applies_to: z.string().min(1).default("all"), // default 'all' (ТЗ §14.2)
  body: z.string().min(10),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type ExtractedCandidate = z.infer<typeof extractedCandidateSchema>;

export interface ExtractionInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly transcript: string; // текст завершённой задачи
  readonly verifier: string; // tests|lint|smoke|human
  readonly verifierId: string;
  readonly scopeHints: readonly string[];
}

export interface ExtractionResult {
  readonly candidates: readonly ExtractedCandidate[];
  readonly notes: string; // что экстрактор заметил, но не стал кандидатом
}

export interface Extractor {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

// --- промпт (схемы + few-shot, ТЗ §16) ---

const FEW_SHOT = `Примеры:
Задача: агент изменил схему БД и сломал миграцию.
Ответ: {"candidates": [{"type": "heuristic", "title": "прогоняй migration-тест до изменения схемы", "scope": "db/migrations", "tags": ["db", "migrations"], "applies_to": "all", "body": "При изменении схемы БД сначала прогоняй migration-тест, потом меняй сущности.", "confidence": 0.8}], "notes": ""}

Задача: человек в ревью: «никогда не коммить .env».
Ответ: {"candidates": [{"type": "negative", "title": "не коммитить .env", "scope": "all", "tags": ["secrets"], "applies_to": "all", "body": "Никогда не добавляй .env в git: секреты попадают в историю.", "confidence": 0.9}], "notes": ""}`;

export function buildExtractionPrompt(input: ExtractionInput): string {
  return `Ты — экстрактор знаний для системы evolve. Из транскрипта завершённой задачи
выдели знания (skill/heuristic/negative/fact/tool_proposal), которые помогут агенту
успешнее в будущих задачах. Только то, что подтверждено задачей/фидбэком — без
спекуляций. Не извлекай знание, которое уже очевидно из кода.

Схема ответа (JSON, без комментариев):
{"candidates": [{"type": "skill|heuristic|negative|fact|tool_proposal",
  "title": "короткий заголовок", "scope": "модуль|glob|all",
  "tags": ["..."], "applies_to": "all|<agent_id>",
  "body": "текст знания (у learnings: цель/шаги/ловушки/критерий готовности)",
  "confidence": 0..1}], "notes": "что замечено, но не стало кандидатом"}

Правила:
- negative — только из явных запретов (человек/критик); scope='all' допустим.
- applies_to=<agent_id> — только для уроков про специфику модели.
- scope: узкая привязка к файлам/модулю лучше, чем 'all'.
- ≤ 5 кандидатов; если знаний нет — пустой массив candidates.

События: task_id=${input.taskId}, agent=${input.agentId}, верификатор=${input.verifier}(${input.verifierId}), scope-подсказки=[${input.scopeHints.join(", ")}]

${FEW_SHOT}

Транскрипт задачи:
<<<
${input.transcript}
>>>

Ответ (только JSON):`;
}

// --- JsonExtractor: реальный LLM (M1, ТЗ A4) ---

const extractionResponseSchema = z.object({
  candidates: z.array(extractedCandidateSchema),
  notes: z.string().default(""),
});

export class JsonExtractor implements Extractor {
  constructor(private readonly llm: TextLlmClient) {}

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const raw = await this.llm.complete(buildExtractionPrompt(input));
    const jsonText = extractJsonBlock(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ExtractorError("EXTRACTOR_INVALID_JSON", `LLM вернул не-JSON: ${detail}`);
    }
    const validated = extractionResponseSchema.safeParse(parsed);
    if (!validated.success) {
      throw new ExtractorError(
        "EXTRACTOR_SCHEMA",
        `схема нарушена: ${validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    const data = validated.data;
    return {
      candidates: data.candidates.slice(0, 5), // правило «≤ 5» — и в промпте, и в коде
      notes: data.notes,
    };
  }
}

/** Извлекает JSON-объект из ответа (допускает ```-обёртки и лишний текст). */
function extractJsonBlock(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fence?.[1] ?? raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new ExtractorError("EXTRACTOR_INVALID_JSON", "в ответе LLM не найден JSON-объект");
  }
  return text.slice(start, end + 1);
}

// --- MockExtractor: детерминированные правила для M0/M1-тестов ---

/**
 * Формат мок-транскрипта: строки «LESSON: <type>:<scope>|<body>|<tags csv>».
 * Имитирует поведение экстрактора без сети (ТЗ M0: тесты на мок-LLM).
 * Невалидные строки (неизвестный type, пустые scope/body) — в notes, не в кандидаты.
 */
const MOCK_LESSON_RE = /^LESSON:\s*([^:|]*):([^|]*)\|([^|]*)(?:\|([^|]*))?\s*$/;
const MOCK_TYPES = new Set<string>(["skill", "heuristic", "negative", "fact", "tool_proposal"]);

export class MockExtractor implements Extractor {
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const candidates: ExtractedCandidate[] = [];
    const notes: string[] = [];
    for (const line of input.transcript.split("\n")) {
      const m = line.match(MOCK_LESSON_RE);
      if (!m) {
        continue;
      }
      const type = m[1] ?? "";
      const scope = m[2] ?? "";
      const body = m[3] ?? "";
      const tagsCsv = m[4] ?? "";
      if (!type || !MOCK_TYPES.has(type) || scope.length === 0 || body.length < 10) {
        notes.push(`пропущена невалидная строка LESSON: ${line.slice(0, 60)}`);
        continue;
      }
      candidates.push({
        type: type as ItemType,
        title: body.slice(0, 60),
        scope,
        tags: tagsCsv.split(",").map((t) => t.trim()).filter((t) => t.length > 0),
        applies_to: "all",
        body,
        confidence: 0.7,
      });
    }
    return { candidates: candidates.slice(0, 5), notes: notes.join("; ") };
  }
}

/** Собирает доменного Candidate из извлечённого + провенанс задачи. */
export function toDomainCandidate(
  extracted: ExtractedCandidate,
  provenance: Candidate["provenance"],
): Candidate {
  return {
    type: extracted.type,
    title: extracted.title,
    scope: extracted.scope,
    tags: extracted.tags,
    appliesTo: extracted.applies_to,
    body: extracted.body,
    provenance,
  };
}
