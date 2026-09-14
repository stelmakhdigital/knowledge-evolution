import { createHash } from "node:crypto";
import type { TelemetryEvent } from "../domain/telemetry.js";
import type { Candidate } from "../domain/types.js";
import type { EvolveConfig } from "../config/config.js";
import type { LlmClient } from "../llm/client.js";
import { admitCandidate, type AdmissionResult, type GateContext } from "../gates/gates.js";
import type { AsyncStore } from "../store/async-store.js";

/**
 * Review-триггер (M4, ТЗ §13/§15 M4): структурированный фидбэк человека или
 * критик-агента (оценка 1..5 + issues) → событие review_recorded + каждый
 * lesson_candidate — обычный кандидат через конвейер (critic — «ещё один
 * источник, не привилегированный», ТЗ §13). G1 для review/critic: верификация =
 * task_id + transcript_hash просмотренной задачи + rating.
 * critic_weight (config.critic) сохраняется в провенанс кандидата — основа
 * авто-веса критика (M4.2) и отчёта («вес-механика видна в отчёте», ТЗ §15 M4).
 */

export type ReviewSourceType = "human" | "critic";
export type IssueType = "bug" | "design" | "missing" | "style" | "other";
export type IssueSeverity = "low" | "med" | "high";

export interface ReviewIssue {
  readonly type: IssueType;
  readonly severity: IssueSeverity;
  readonly evidence: string;
  readonly lessonCandidate?: string;
}

export interface ReviewInput {
  readonly taskId: string;
  readonly source: ReviewSourceType;
  /** Агент, чью задачу ревью (G5-лимиты). */
  readonly agentId: string;
  readonly rating: number; // 1..5
  readonly transcriptHash: string;
  readonly commit: string;
  readonly issues: readonly ReviewIssue[];
  readonly llm: LlmClient;
  readonly type?: Candidate["type"];
  readonly scope?: string;
  readonly appliesTo?: string;
  /** Последний авто-вес критика (М4.2); null — базовый config.critic.weight. */
  readonly criticWeight?: number | null;
}

export interface ReviewOutcome {
  readonly candidates: readonly AdmissionResult[];
}

export async function recordReview(
  store: AsyncStore,
  config: EvolveConfig,
  input: ReviewInput,
  now: Date,
): Promise<ReviewOutcome> {
  if (!(input.rating >= 1 && input.rating <= 5)) {
    throw new Error("rating должен быть 1..5");
  }
  const event: TelemetryEvent = {
    event: "review_recorded",
    task_id: input.taskId,
    source: input.source,
    rating: input.rating,
    issues: input.issues.map((i) => ({
      type: i.type,
      severity: i.severity,
      evidence: i.evidence,
      ...(i.lessonCandidate != null && i.lessonCandidate.length > 0
        ? { lesson_candidate: i.lessonCandidate }
        : {}),
    })),
    recorded_at: now.toISOString(),
  };
  await store.addEvent(event);

  const results: AdmissionResult[] = [];
  let i = 0;
  for (const issue of input.issues) {
    const lesson = issue.lessonCandidate ?? "";
    if (lesson.trim().length === 0) {
      continue; // issue без lesson — только телеметрия
    }
    i += 1;
    const candidate: Candidate = {
      type: input.type ?? "heuristic",
      title: lesson.slice(0, 80),
      scope: input.scope ?? "all",
      tags: [issue.type, "review"],
      appliesTo: input.appliesTo ?? "all",
      body: lesson,
      provenance: {
        sourceType: input.source === "critic" ? "critic" : "review",
        taskId: input.taskId,
        transcriptHash: input.transcriptHash,
        commit: input.commit,
        payload: {
          rating: input.rating,
          issue_type: issue.type,
          issue_severity: issue.severity,
          evidence: issue.evidence,
          critic_weight: input.criticWeight ?? config.critic.weight,
        },
        createdAt: now.toISOString(),
      },
    };
    const candidateRef = `rvw-${createHash("sha256").update(lesson).digest("hex").slice(0, 8)}-${i}-${input.taskId}`;
    const ctx: GateContext = {
      candidate,
      candidateRef,
      store,
      config,
      llm: input.llm,
      clock: () => now,
      agentId: input.agentId,
    };
    const res = await admitCandidate(ctx);
    results.push(res);
  }
  return { candidates: results };
}
