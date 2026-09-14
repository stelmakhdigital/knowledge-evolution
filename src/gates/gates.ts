import { randomUUID } from "node:crypto";
import type { EvolveConfig } from "../config/config.js";
import { hashBody } from "../domain/hashing.js";
import {
  ALWAYS_HIGH_RISK_TYPES,
  type Candidate,
  type Clock,
  type GateName,
  type GateResult,
  type Item,
  type RiskTier,
} from "../domain/types.js";
import { cosineSimilarity, type LlmClient } from "../llm/client.js";
import type { Store } from "../store/store.js";

/**
 * Гейты G1–G5 (ТЗ §9): синхронные, дешёвые, конфигурируемые.
 * Порядок исполнения: G1 evidence → G2 dedup → G4 scope (risk_tier) → G5 budget
 * → при приёме создаётся item → G3 conflict (нужен id item для contradictions)
 * → решение по risk_tier: low → canary (авто), high → queued (человек).
 * Примечание: G3 выполняется после создания item, т.к. contradictions
 * ссылается на item_id (ТЗ §7.1); по семантике — тот же гейт до canary/queue.
 */

export interface GateContext {
  readonly candidate: Candidate;
  readonly /** Идентификатор кандидата для gate_results (генерирует экстрактор/CLI). */ candidateRef: string;
  readonly store: Store;
  readonly config: EvolveConfig;
  readonly llm: LlmClient;
  readonly clock: Clock;
  /** Агент, породивший кандидата (G5: лимиты на агента). */
  readonly agentId: string;
}

export type GateDecision = "accept" | "reject" | "merge";

export interface GateRunResult {
  readonly results: readonly GateResult[]; // в порядке исполнения, со стопом на fail
  readonly riskTier: RiskTier;
  readonly decision: GateDecision;
  readonly reason: string;
  /** G2 fail: id item, с которым кандидат — merge-предложение. */
  readonly mergeItemId?: string;
  /** G3 fail: id созданного contradiction. */
  readonly contradictionId?: string;
}

export interface AdmissionResult {
  readonly gates: GateRunResult;
  /** item — только при decision='accept'. */
  readonly item?: Item;
}

function gateResult(
  ctx: Pick<GateContext, "candidateRef" | "clock">,
  gate: GateName,
  outcome: "pass" | "fail",
  detail: Readonly<Record<string, unknown>>,
): GateResult {
  return {
    id: randomUUID(),
    candidateId: ctx.candidateRef,
    gate,
    outcome,
    detail,
    createdAt: ctx.clock().toISOString(),
  };
}

// --- G1 evidence: есть task_id + верификация (не self-reported) ---

export function gateEvidence(ctx: GateContext): GateResult {
  const p = ctx.candidate.provenance;
  const verifier = typeof p.payload["verifier"] === "string" ? (p.payload["verifier"] as string) : "";
  const detail: Record<string, unknown> = { agent_id: ctx.agentId };
  if (p.taskId.length === 0 || p.transcriptHash.length === 0 || verifier.length === 0) {
    return gateResult(ctx, "evidence", "fail", {
      ...detail,
      reason: "провенанс без верификации (self-reported запрещён, ТЗ G1)",
      has_task_id: p.taskId.length > 0,
      has_transcript_hash: p.transcriptHash.length > 0,
      verifier: verifier || null,
    });
  }
  return gateResult(ctx, "evidence", "pass", { ...detail, verifier });
}

// --- G2 dedup: cos_sim с базой ≥ θ_dedup → merge-предложение ---

export function gateDedup(ctx: GateContext): GateResult {
  const query = ctx.llm.embed(ctx.candidate.body);
  const existing = ctx.store.listItems().filter((i) => i.status !== "archived");
  let best: { id: string; similarity: number } | null = null;
  for (const item of existing) {
    const similarity = cosineSimilarity(query, ctx.llm.embed(item.body));
    if (best === null || similarity > best.similarity) {
      best = { id: item.id, similarity };
    }
  }
  if (best !== null && best.similarity >= ctx.config.theta_dedup) {
    return gateResult(ctx, "dedup", "fail", {
      reason: `cos_sim=${best.similarity.toFixed(3)} ≥ θ_dedup=${ctx.config.theta_dedup} → не новый item, а merge-предложение`,
      merge_item_id: best.id,
      similarity: Number(best.similarity.toFixed(6)),
    });
  }
  return gateResult(ctx, "dedup", "pass", {
    max_similarity: best === null ? 0 : Number(best.similarity.toFixed(6)),
  });
}

// --- G4 scope: широта → risk_tier ---

export function riskTierOf(candidate: Candidate): RiskTier {
  if (ALWAYS_HIGH_RISK_TYPES.has(candidate.type)) {
    return "high"; // negative и tool_proposal — всегда high (ТЗ §8)
  }
  return candidate.scope === "all" ? "high" : "low"; // привязка к файлам/модулю → low
}

export function gateScope(ctx: GateContext): GateResult {
  const riskTier = riskTierOf(ctx.candidate);
  return gateResult(ctx, "scope", "pass", {
    risk_tier: riskTier,
    scope: ctx.candidate.scope,
    type: ctx.candidate.type,
  });
}

// --- G5 budget: лимиты (ТЗ G5, A5) ---

export function gateBudget(ctx: GateContext): GateResult {
  const { budget } = ctx.config;
  const items = ctx.store.listItems();
  const activeCount = items.filter((i) => i.status === "active").length;
  // Приближение M0 (задокументировано): «queue/нед» = текущий объём очереди.
  const queuedCount = items.filter((i) => i.status === "queued").length;
  // «Кандидатов/агент/день» — по G1-результатам (первый гейт) за сегодня с detail.agent_id.
  // В конвейере G1 текущего кандидата уже записан до G5, т.е. он учтён в счёте:
  // лимит N означает, что проходят N кандидатов, (N+1)-й отклоняется.
  const todayStart = ctx.clock().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const candidatesToday = ctx.store.listGateResults({
    gate: "evidence",
    since: todayStart,
    agentId: ctx.agentId,
  }).length;

  if (activeCount >= budget.active_max) {
    return gateResult(ctx, "budget", "fail", {
      reason: `active=${activeCount} ≥ cap=${budget.active_max}`,
      active_count: activeCount,
      limit: budget.active_max,
    });
  }
  if (queuedCount >= budget.queue_per_week_max) {
    return gateResult(ctx, "budget", "fail", {
      reason: `queued=${queuedCount} ≥ queue_per_week=${budget.queue_per_week_max}`,
      queued_count: queuedCount,
      limit: budget.queue_per_week_max,
    });
  }
  if (candidatesToday > budget.candidates_per_agent_per_day_max) {
    return gateResult(ctx, "budget", "fail", {
      reason: `кандидатов агента ${ctx.agentId} сегодня: ${candidatesToday} ≥ ${budget.candidates_per_agent_per_day_max}`,
      candidates_today: candidatesToday,
      agent_id: ctx.agentId,
      limit: budget.candidates_per_agent_per_day_max,
    });
  }
  return gateResult(ctx, "budget", "pass", {
    active_count: activeCount,
    queued_count: queuedCount,
    candidates_today: candidatesToday,
    active_max: budget.active_max,
    queue_per_week_max: budget.queue_per_week_max,
    candidates_per_agent_per_day_max: budget.candidates_per_agent_per_day_max,
  });
}

// --- G3 conflict: LLM-детектор противоречий с active (после создания item) ---

export async function gateConflict(item: Item, ctx: Omit<GateContext, "candidate"> & { candidateRef: string }): Promise<GateResult> {
  const activeItems = ctx.store.listItems({ status: "active" });
  for (const other of activeItems) {
    const verdict = await ctx.llm.detectConflict(item.body, other.body);
    if (verdict.conflicting) {
      const contradictionId = randomUUID();
      ctx.store.addContradiction({
        id: contradictionId,
        itemAId: item.id,
        itemBId: other.id,
        severity: "med",
        status: "open",
        resolvedBy: null,
        createdAt: ctx.clock().toISOString(),
      });
      return gateResult(ctx, "conflict", "fail", {
        reason: "найдено противоречие с active → contradictions.open (ТЗ G3)",
        contradiction_id: contradictionId,
        item_b_id: other.id,
        evidence: verdict.evidence,
      });
    }
  }
  return gateResult(ctx, "conflict", "pass", { active_checked: activeItems.length });
}

/**
 * Полный конвейер кандидата (ТЗ §9): гейты → item → риск-решение.
 * ТЗ §8: единственный путь создания item — кандидат + гейты.
 */
export async function admitCandidate(ctx: GateContext): Promise<AdmissionResult> {
  const results: GateResult[] = [];
  const riskTier = riskTierOf(ctx.candidate);

  const record = (r: GateResult): void => {
    results.push(r);
    ctx.store.addGateResult(r);
  };

  const g1 = gateEvidence(ctx);
  record(g1);
  if (g1.outcome === "fail") {
    return { gates: { results, riskTier, decision: "reject", reason: g1.detail["reason"] as string } };
  }

  const g2 = gateDedup(ctx);
  record(g2);
  if (g2.outcome === "fail") {
    return {
      gates: {
        results,
        riskTier,
        decision: "merge",
        reason: g2.detail["reason"] as string,
        mergeItemId: g2.detail["merge_item_id"] as string,
      },
    };
  }

  const g4 = gateScope(ctx);
  record(g4);

  const g5 = gateBudget(ctx);
  record(g5);
  if (g5.outcome === "fail") {
    return { gates: { results, riskTier, decision: "reject", reason: g5.detail["reason"] as string } };
  }

  // Принято: создаём item (старт — candidate, ТЗ §8).
  const now = ctx.clock().toISOString();
  const c = ctx.candidate;
  const item: Item = {
    id: randomUUID(),
    type: c.type,
    title: c.title,
    scope: c.scope,
    tags: [...c.tags],
    appliesTo: c.appliesTo,
    status: "candidate",
    riskTier,
    version: 1,
    body: c.body,
    bodyHash: hashBody(c.body),
    embeddingId: null,
    scoreGlobal: 0,
    createdAt: now,
    updatedAt: now,
  };
  ctx.store.addItem({
    item,
    provenance: [c.provenance],
    initialDecision: {
      itemId: item.id,
      version: 1,
      kind: "promote",
      actor: "auto:gate",
      reason: "кандидат принят гейтами G1–G5",
      evidence: { candidate_ref: ctx.candidateRef, gates: ["evidence", "dedup", "scope", "budget"] },
    },
  });

  // G3 — с id item (см. примечание в шапке модуля).
  const g3 = await gateConflict(item, ctx);
  results.push(g3);
  ctx.store.addGateResult(g3);
  const finalTier: RiskTier = g3.outcome === "fail" ? "high" : riskTier; // противоречие → в очередь к человеку

  const updated = ctx.store.applyTransition(item.id, {
    to: finalTier === "low" ? "canary" : "queued",
    kind: "promote",
    actor: "auto:gate",
    reason: finalTier === "low"
      ? "risk_tier=low → canary (авто, ТЗ §9)"
      : `risk_tier=high${g3.outcome === "fail" ? " (+противоречие)" : ""} → queue (человек, ТЗ §9)`,
    evidence: { risk_tier: finalTier, contradiction: g3.detail["contradiction_id"] ?? null },
  });

  const gateRunResult: GateRunResult = g3.outcome === "fail"
    ? {
        results,
        riskTier: finalTier,
        decision: "accept",
        reason: `принят: ${updated.status}`,
        contradictionId: g3.detail["contradiction_id"] as string,
      }
    : { results, riskTier: finalTier, decision: "accept", reason: `принят: ${updated.status}` };

  return { item: updated, gates: gateRunResult };
}
