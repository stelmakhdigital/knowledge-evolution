import { z } from "zod";
import type { EvolveConfig } from "../config/config.js";
import type { TelemetrySnapshot } from "../meta/proposer.js";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

/**
 * LLM-пропонер (M6.2, harness.md §9): поверх детерминированных правил (M6.1)
 * пропонер предлагает ДОПОЛНИТЕЛЬНЫЕ правки harness (пороги, бюджеты,
 * retrieval, ablation), оперируя harness-документом и телеметрией.
 * Proposer не меняет harness напрямую: валидация + очередь человека +
 * промоут только при golden success-rate ≥ baseline + 5 п.п. И cost ≤ baseline.
 *
 * Реальный LLM — реализация HarnessProposer поверх API (промпт = контекст
 * ниже). MockHarnessProposer детерминирован (тесты, оффлайн).
 */

export interface ProposalContext {
  readonly telemetry: TelemetrySnapshot;
  readonly config: Record<string, unknown>;
  /** Вырез harness-документа (секции, которые можно править). */
  readonly harnessDoc: string;
}

/** Сырое предложение пропонера (до валидации). */
export interface RawHarnessProposal {
  field: string;
  newValue: string;
  rationale: string;
  evidence?: Record<string, unknown>;
}

export interface HarnessProposer {
  readonly name: string;
  propose(ctx: ProposalContext): Promise<RawHarnessProposal[]>;
}

// --- Валидация: whitelist полей, old_value = актуальное, диапазоны ---

const weight = (min: number, max: number): z.ZodNumber => z.number().min(min).max(max);

const fieldSchemas: Record<string, { schema: z.ZodTypeAny; current: (c: EvolveConfig) => string }> = {
  "theta_dedup": { schema: weight(0.5, 0.99), current: (c) => String(c.theta_dedup) },
  "theta_score": { schema: weight(0.1, 0.9), current: (c) => String(c.theta_score) },
  "canary.window_days": { schema: z.number().int().min(3).max(30), current: (c) => String(c.canary.window_days) },
  "canary.min_retrievals": { schema: z.number().int().min(2).max(20), current: (c) => String(c.canary.min_retrievals) },
  "canary.cost_multiplier_max": { schema: z.number().min(1).max(3), current: (c) => String(c.canary.cost_multiplier_max) },
  "degradation.unused_days": { schema: z.number().int().min(14).max(60), current: (c) => String(c.degradation.unused_days) },
  "degradation.open_contradiction_days": { schema: z.number().int().min(3).max(30), current: (c) => String(c.degradation.open_contradiction_days) },
  "retrieval.top_k": { schema: z.number().int().min(3).max(20), current: (c) => String(c.retrieval.top_k) },
  "budget.active_max": { schema: z.number().int().min(50).max(1000), current: (c) => String(c.budget.active_max) },
  "ablation.dedup": { schema: z.boolean(), current: (c) => String(c.ablation.dedup) },
  "ablation.conflict": { schema: z.boolean(), current: (c) => String(c.ablation.conflict) },
  "ablation.canary": { schema: z.boolean(), current: (c) => String(c.ablation.canary) },
  "ablation.critic": { schema: z.boolean(), current: (c) => String(c.ablation.critic) },
  "ablation.negative": { schema: z.boolean(), current: (c) => String(c.ablation.negative) },
};

const rawSchema = z.object({
  field: z.string().min(1),
  newValue: z.string().min(1),
  rationale: z.string().min(10),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

export interface ValidatedProposal {
  readonly field: string;
  readonly oldValue: string;
  readonly newValue: string;
  readonly rationale: string;
  readonly evidence: Record<string, unknown>;
}

export interface ValidationReport {
  readonly accepted: readonly ValidatedProposal[];
  readonly rejected: readonly { field: string; reason: string }[];
}

/** Валидация предложений пропонера: whitelist, old_value, диапазоны, повторность. */
export function validateProposals(raw: RawHarnessProposal[], config: EvolveConfig): ValidationReport {
  const accepted: ValidatedProposal[] = [];
  const rejected: { field: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const parsed = rawSchema.safeParse(r);
    if (!parsed.success) {
      rejected.push({ field: r.field, reason: `схема: ${parsed.error.issues[0]?.message ?? "ошибка"}` });
      continue;
    }
    const spec = fieldSchemas[r.field];
    if (!spec) {
      rejected.push({ field: r.field, reason: "поле не в whitelist harness (ТЗ §14: только параметры политик)" });
      continue;
    }
    const oldValue = spec.current(config);
    const parsedValue = spec.schema.safeParse(
      spec.schema instanceof z.ZodBoolean ? r.newValue === "true" : Number(r.newValue),
    );
    if (!parsedValue.success) {
      rejected.push({ field: r.field, reason: `значение '${r.newValue}' вне допустимых границ` });
      continue;
    }
    const newValue = r.newValue.trim();
    if (newValue === oldValue) {
      rejected.push({ field: r.field, reason: "нет изменения (newValue = oldValue)" });
      continue;
    }
    if (seen.has(`${r.field}=${newValue}`)) {
      rejected.push({ field: r.field, reason: "дубликат в одном прогоне" });
      continue;
    }
    seen.add(`${r.field}=${newValue}`);
    accepted.push({
      field: r.field,
      oldValue,
      newValue,
      rationale: parsed.data.rationale,
      evidence: { proposer: "llm", ...(parsed.data.evidence ?? {}) },
    });
  }
  return { accepted, rejected };
}

/** Запись валидных предложений в очередь (общий путь с M6.1-правилами). */
export async function insertProposals(
  pool: Pool,
  proposals: readonly ValidatedProposal[],
  target: string,
): Promise<{ created: number; skippedDuplicates: number }> {
  let created = 0;
  let skipped = 0;
  for (const p of proposals) {
    const dup = await pool.query(
      `SELECT count(*)::int AS n FROM proposals
       WHERE field = $1 AND new_value = $2 AND status IN ('proposed', 'accepted', 'applied')`,
      [p.field, p.newValue],
    );
    if (Number(dup.rows[0]["n"]) > 0) {
      skipped += 1;
      continue;
    }
    await pool.query(
      `INSERT INTO proposals (id, target, field, old_value, new_value, rationale, evidence, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed')`,
      [randomUUID(), target, p.field, p.oldValue, p.newValue, p.rationale, JSON.stringify(p.evidence)],
    );
    created += 1;
  }
  return { created, skippedDuplicates: skipped };
}

/**
 * Детерминированный mock (тесты, оффлайн, отсутствие API):
 * простые условия на контексте → фиксированные правки (включая намеренно
 * невалидные, для проверки валидатора).
 */
export class MockHarnessProposer implements HarnessProposer {
  readonly name = "mock-harness-proposer";

  async propose(ctx: ProposalContext): Promise<RawHarnessProposal[]> {
    const out: RawHarnessProposal[] = [];
    const t = ctx.telemetry;
    // сигнал: retrieval давит (много пропозалов уже в очереди, top_k велик) → сузить выдачу
    if (t.proposalsActive >= 2) {
      out.push({
        field: "retrieval.top_k",
        newValue: "4",
        rationale: "очередь правок растёт: сузить выдачу (top_k 4) ради стабильности инъекций",
        evidence: { proposals_active: t.proposalsActive },
      });
    }
    // сигнал: dedup шумит → ослабить (дополнение к правилу S1)
    if (t.dedup.total >= 10 && t.dedup.passRate < 0.5) {
      out.push({
        field: "theta_dedup",
        newValue: "0.9",
        rationale: "LLM-оценка: дедуп слишком строгий, 0.9 снизит merge-шум",
        evidence: { dedup_pass_rate: t.dedup.passRate },
      });
    }
    // намеренно невалидные: whitelist и границы
    out.push({
      field: "items.max_length",
      newValue: "10000",
      rationale: "невалидное: поле не в whitelist (проверка валидатора)",
    });
    out.push({
      field: "theta_score",
      newValue: "0.99",
      rationale: "невалидное: вне границ (макс 0.9) — проверка валидатора",
    });
    return out;
  }
}
