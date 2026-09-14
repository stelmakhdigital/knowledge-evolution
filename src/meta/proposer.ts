import { randomUUID } from "node:crypto";
import type { EvolveConfig } from "../config/config.js";
import type { Pool } from "pg";

/**
 * Agentic proposer (M6.1, ТЗ §15: meta-оптимизация; harness.md §9).
 * Proposer читает telemetry (gate_results, usage_log, decisions, budgets)
 * и предлагает **кандидатные правки harness** (пороги, бюджеты, ablation) —
 * в очередь человека. Proposer не меняет harness напрямую: каждое решение —
 * человек + метрики; промоут правки только при success-rate на golden ≥
 * baseline + 5 п.п. И cost ≤ baseline (cost-gate).
 *
 * M6.1-приближение (задокументировано): детерминированные правила по
 * сигналам за 30 дней (LLM-пропонер — M6.2, интерфейс готов:
 * Proposal = target/field/old/new/rationale/evidence).
 * Идемпотентность: не дублируем активное (proposed/accepted/applied)
 * предложение с тем же field+new_value.
 */

export interface Proposal {
  readonly id: string;
  readonly target: string;
  readonly field: string;
  readonly oldValue: string;
  readonly newValue: string;
  readonly rationale: string;
  readonly evidence: Record<string, unknown>;
}

export interface ProposeResult {
  readonly created: readonly Proposal[];
  readonly skippedDuplicates: number;
}

interface DedupSignal {
  readonly total: number;
  readonly passRate: number;
}

async function dedupSignal(pool: Pool, now: Date): Promise<DedupSignal> {
  const res = await pool.query(
    `SELECT count(*)::int AS total,
            coalesce(sum(CASE WHEN result = 'pass' THEN 1 ELSE 0 END), 0)::int AS passes
     FROM gate_results WHERE gate = 'dedup' AND created_at >= now() - interval '30 days'`,
  );
  const row = res.rows[0];
  const total = Number(row["total"]);
  return { total, passRate: total === 0 ? 1 : Number(row["passes"]) / total };
}

async function activeCount(pool: Pool): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS n FROM items WHERE status = 'active'`);
  return Number(res.rows[0]["n"]);
}

/** (agent → success-rate, verdicts) за 30 дней + baseline по всем. */
async function successByAgent(pool: Pool): Promise<{ byAgent: Map<string, { sr: number; verdicts: number }>; baseline: number }> {
  const res = await pool.query(
    `SELECT agent_id,
            count(*) FILTER (WHERE task_success IS NOT NULL)::int AS verdicts,
            count(*) FILTER (WHERE task_success)::int AS successes
     FROM usage_log WHERE retrieved_at >= now() - interval '30 days'
     GROUP BY agent_id`,
  );
  const byAgent = new Map<string, { sr: number; verdicts: number }>();
  let allVerdicts = 0;
  let allSuccesses = 0;
  for (const r of res.rows) {
    const verdicts = Number(r["verdicts"]);
    const sr = verdicts === 0 ? 0.5 : Number(r["successes"]) / verdicts;
    byAgent.set(r["agent_id"] as string, { sr, verdicts });
    allVerdicts += verdicts;
    allSuccesses += Number(r["successes"]);
  }
  const baseline = allVerdicts === 0 ? 0.5 : allSuccesses / allVerdicts;
  return { byAgent, baseline };
}

async function canaryOutcome(pool: Pool): Promise<{ promote: number; demote: number }> {
  const res = await pool.query(
    `SELECT kind, count(*)::int AS n
     FROM decisions
     WHERE actor = 'auto:canary' AND created_at >= now() - interval '30 days'
     GROUP BY kind`,
  );
  let promote = 0;
  let demote = 0;
  for (const r of res.rows) {
    if (r["kind"] === "promote") {
      promote = Number(r["n"]);
    } else if (r["kind"] === "demote") {
      demote = Number(r["n"]);
    }
  }
  return { promote, demote };
}

async function activeProposals(pool: Pool, field: string, newValue: string): Promise<number> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM proposals
     WHERE field = $1 AND new_value = $2 AND status IN ('proposed', 'accepted', 'applied')`,
    [field, newValue],
  );
  return Number(res.rows[0]["n"]);
}

/** Телеметрия за 30 дней — общий контекст для правил (M6.1) и LLM-пропонера (M6.2). */
export interface TelemetrySnapshot {
  readonly dedup: DedupSignal;
  readonly activeCount: number;
  readonly budget: { active_max: number; pressure: number };
  readonly successByAgent: Record<string, { sr: number; verdicts: number }>;
  readonly baseline: number;
  readonly canary: { promote: number; demote: number };
  readonly ablation: Record<string, boolean>;
  readonly proposalsActive: number;
  readonly windowDays: number;
}

export async function collectSignals(pool: Pool, config: EvolveConfig, now: Date): Promise<TelemetrySnapshot> {
  const dedup = await dedupSignal(pool, now);
  const activeN = await activeCount(pool);
  const success = await successByAgent(pool);
  const canary = await canaryOutcome(pool);
  const activeCountRes = await pool.query(
    `SELECT count(*)::int AS n FROM proposals WHERE status IN ('proposed', 'accepted', 'applied')`,
  );
  const agentMap: Record<string, { sr: number; verdicts: number }> = {};
  for (const [k, v] of success.byAgent.entries()) {
    agentMap[k] = { sr: v.sr, verdicts: v.verdicts };
  }
  return {
    dedup,
    activeCount: activeN,
    budget: { active_max: config.budget.active_max, pressure: Number((activeN / config.budget.active_max).toFixed(4)) },
    successByAgent: agentMap,
    baseline: success.baseline,
    canary,
    ablation: { ...config.ablation },
    proposalsActive: Number(activeCountRes.rows[0]["n"]),
    windowDays: 30,
  };
}

export async function runProposer(pool: Pool, config: EvolveConfig, now: Date): Promise<ProposeResult> {
  const created: Proposal[] = [];

  const propose = (
    target: string,
    field: string,
    oldValue: string,
    newValue: string,
    rationale: string,
    evidence: Record<string, unknown>,
  ): void => {
    created.push({ id: randomUUID(), target, field, oldValue, newValue, rationale, evidence });
  };

  // S1: чувствительность G2 (дедуп): pass < 50% → кандидаты в основном дубли → θ выше.
  const dedup = await dedupSignal(pool, now);
  if (dedup.total >= 10 && dedup.passRate < 0.5) {
    const old = config.theta_dedup;
    const next = Math.min(0.95, Number((old + 0.05).toFixed(2)));
    if (next !== old) {
      propose(
        "config.yaml / harness.md §2",
        "theta_dedup",
        String(old),
        String(next),
        `G2 за 30 дней: pass ${(dedup.passRate * 100).toFixed(0)}% из ${dedup.total} — кандидаты в основном дубли, θ_dedup слишком строгий; поднятие на ${next} уменьшит merge-шум`,
        { window_days: 30, dedup_total: dedup.total, dedup_pass_rate: Number(dedup.passRate.toFixed(4)) },
      );
    }
  }

  // S2: давление на бюджет active → активнее деградация (θ_score ниже).
  const activeN = await activeCount(pool);
  const budget = config.budget.active_max;
  if (activeN > 0.8 * budget) {
    const old = config.theta_score;
    const next = Math.max(0.15, Number((old - 0.05).toFixed(2)));
    if (next !== old) {
      propose(
        "config.yaml / harness.md §4",
        "theta_score",
        String(old),
        String(next),
        `active ${activeN}/${budget} (> 80% бюджета): ускорить деградацию слабых элементов (θ_score ${next}) вместо расширения бюджета`,
        { active_count: activeN, active_max: budget, pressure: Number((activeN / budget).toFixed(3)) },
      );
    }
  }

  // S3: success-rate агента ниже baseline ≥ 0.1 → ablation-эксперимент (неделя, ТЗ §12.4).
  const { byAgent, baseline } = await successByAgent(pool);
  for (const [agent, s] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (s.verdicts >= 10 && s.sr < baseline - 0.1 && config.ablation.negative !== false) {
      propose(
        "config.yaml / harness.md §6",
        "ablation.negative",
        "true",
        "false",
        `success-rate '${agent}' ${(s.sr * 100).toFixed(0)}% ниже baseline ${(baseline * 100).toFixed(0)}% (verdicts ${s.verdicts}): недельный ablation-эксперимент — выключить negative-инъекции для агента`,
        { agent, success_rate: Number(s.sr.toFixed(4)), baseline: Number(baseline.toFixed(4)), verdicts: s.verdicts },
      );
      break; // один эксперименный ablation за раунд
    }
  }

  // S4: canary часто demote → больше данных перед авто-промоутом (min_uses выше).
  const canary = await canaryOutcome(pool);
  const canaryTotal = canary.promote + canary.demote;
  if (canaryTotal >= 5 && canary.demote / canaryTotal >= 0.3) {
    const old = config.canary.min_retrievals;
    propose(
      "config.yaml / harness.md §3",
      "canary.min_retrievals",
      String(old),
      String(old + 1),
      `canary за 30 дней: demote ${canary.demote}/${canaryTotal} (≥ 30%): авто-промоуту не хватает данных — поднять min_uses до ${old + 1}`,
      { window_days: 30, promote: canary.promote, demote: canary.demote, demote_share: Number((canary.demote / canaryTotal).toFixed(3)) },
    );
  }

  // Идемпотентность + запись в очередь.
  const inserted: Proposal[] = [];
  let skipped = 0;
  for (const p of created) {
    if ((await activeProposals(pool, p.field, p.newValue)) > 0) {
      skipped += 1;
      continue;
    }
    await pool.query(
      `INSERT INTO proposals (id, target, field, old_value, new_value, rationale, evidence, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed')`,
      [p.id, p.target, p.field, p.oldValue, p.newValue, p.rationale, JSON.stringify(p.evidence)],
    );
    inserted.push(p);
  }

  return { created: inserted, skippedDuplicates: skipped };
}

export async function listProposals(pool: Pool, status?: string): Promise<Record<string, unknown>[]> {
  const sql = status
    ? `SELECT * FROM proposals WHERE status = $1 ORDER BY created_at DESC`
    : `SELECT * FROM proposals ORDER BY created_at DESC`;
  const res = status ? await pool.query(sql, [status]) : await pool.query(sql);
  return res.rows;
}

export async function decideProposal(
  pool: Pool,
  id: string,
  decision: "applied" | "rejected",
  decidedBy: string,
  notes: string,
  now: Date,
): Promise<Record<string, unknown> | null> {
  const res = await pool.query(
    `UPDATE proposals SET status = $2, decided_by = $3, decided_at = $4, notes = $5
     WHERE id = $1 AND status IN ('proposed', 'accepted')
     RETURNING *`,
    [id, decision, decidedBy, now.toISOString(), notes],
  );
  return res.rows.length > 0 ? (res.rows[0] as Record<string, unknown>) : null;
}
