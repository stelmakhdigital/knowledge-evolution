import { z } from "zod";
import type { UsageLogEntry, Verifier } from "./types.js";

/**
 * События телеметрии (ТЗ §11.1). Внешние данные (транскрипты, фидбэк) — unknown,
 * сужаются только zod-схемами здесь.
 * knowledge_used пишется ДО начала задачи (ТЗ §10.3) — метрика «знание было доступно».
 * task_verified — verifier_id + human_override (ТЗ §11.4: верификатор — абляционный модуль).
 */

export const taskStartedSchema = z.object({
  event: z.literal("task_started"),
  task_id: z.string().min(1),
  agent_id: z.string().min(1),
  scope_hints: z.array(z.string()).default([]),
  started_at: z.string(), // ISO-8601
});

export const knowledgeUsedSchema = z.object({
  event: z.literal("knowledge_used"),
  task_id: z.string().min(1),
  item_id: z.string().min(1),
  version: z.number().int().positive(),
  agent_id: z.string().min(1),
  used_at: z.string(),
});

export const taskVerifiedSchema = z.object({
  event: z.literal("task_verified"),
  task_id: z.string().min(1),
  agent_id: z.string().min(1),
  success: z.boolean(),
  verifier: z.enum(["tests", "lint", "smoke", "human"]),
  verifier_id: z.string().min(1), // ТЗ §11.4: какой именно верификатор (ablation)
  human_override: z.boolean().optional(),
  verified_at: z.string(),
});

export const reviewIssueSchema = z.object({
  type: z.enum(["bug", "design", "missing", "style", "other"]),
  severity: z.enum(["low", "med", "high"]),
  evidence: z.string(), // file:line / тест / цитата
  lesson_candidate: z.string().optional(),
});

export const reviewRecordedSchema = z.object({
  event: z.literal("review_recorded"),
  task_id: z.string().min(1),
  source: z.enum(["human", "critic"]),
  rating: z.number().int().min(1).max(5),
  issues: z.array(reviewIssueSchema).default([]),
  recorded_at: z.string(),
});

export const telemetryEventSchema = z.discriminatedUnion("event", [
  taskStartedSchema,
  knowledgeUsedSchema,
  taskVerifiedSchema,
  reviewRecordedSchema,
]);

export type TaskStarted = z.infer<typeof taskStartedSchema>;
export type KnowledgeUsed = z.infer<typeof knowledgeUsedSchema>;
export type TaskVerified = z.infer<typeof taskVerifiedSchema>;
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;
export type ReviewRecorded = z.infer<typeof reviewRecordedSchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/** Ошибка валидации события (машиночитаемый код для CLI-границы). */
export class TelemetryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TelemetryError";
    this.code = code;
  }
}

/**
 * Backfill: по завершённой задаче заполняем task_success у всех usage_log
 * этой задачи (ТЗ §10.3: метрика честная — знание было доступно ДО старта).
 * Возвращает список обновлённых записей; повторный вызов идемпотентен
 * (первый вердикт — приоритет, конфликты — ошибка TELEMETRY_CONFLICT).
 */
export function backfillTaskSuccess(
  usageEntries: readonly UsageLogEntry[],
  taskId: string,
  success: boolean,
): { updated: UsageLogEntry[]; unchanged: number } {
  const updated: UsageLogEntry[] = [];
  let unchanged = 0;
  for (const entry of usageEntries) {
    if (entry.taskId !== taskId) {
      continue;
    }
    if (entry.taskSuccess === null) {
      updated.push({ ...entry, taskSuccess: success });
    } else if (entry.taskSuccess !== success) {
      throw new TelemetryError(
        "TELEMETRY_CONFLICT",
        `usage_log ${entry.id}: уже записан вердикт ${entry.taskSuccess}, новый — ${success} (task ${taskId})`,
      );
    } else {
      unchanged += 1;
    }
  }
  return { updated, unchanged };
}

export type { Verifier };
