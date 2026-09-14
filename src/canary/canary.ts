import type { EvolveConfig } from "../config/config.js";
import type { PgStore } from "../store/pg-store.js";

/**
 * Canary-цикл (M2, ТЗ §9/§9.1): авто-решения по canary-элементам без человека.
 * Правило окна (config.canary): оцениваем, когда истекло window_days (7) —
 * «7 дней ИЛИ ≥ min_retrievals (что наступит позже)» = окно и минимальные данные.
 *   hold:    окно не истекло / извлечений < min_retrievals / нет вердиктов верификатора;
 *   demote:  cost-gate (ТЗ §9.1: стоимость ≤ baseline × 1.2; M2-прокси — длина тела
 *            vs среднее по active, задокументировано) ИЛИ success_rate < baseline − ε;
 *   promote: success_rate ≥ baseline − ε (baseline — success-rate активного ядра;
 *            без baseline — порог 1 − ε).
 * Каждое решение — decision actor='auto:canary' (откат — rollback, ТЗ §12.1).
 */

export type CanaryOutcome = "promote" | "demote" | "hold";

export interface CanaryVerdict {
  readonly itemId: string;
  readonly title: string;
  readonly outcome: CanaryOutcome;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

const DAY_MS = 86_400_000;

export async function evaluateCanaries(
  store: PgStore,
  config: EvolveConfig,
  now: Date,
): Promise<CanaryVerdict[]> {
  const pool = store.pool;
  const canaries = await pool.query(`SELECT id, title, body, updated_at FROM items WHERE status = 'canary'`);

  // baseline: success-rate usage активного ядра (только вердикты, известные).
  const base = await pool.query(
    `SELECT count(*) FILTER (WHERE u.task_success)::int AS succ,
            count(*) FILTER (WHERE u.task_success IS NOT NULL)::int AS verdicts
     FROM usage_log u JOIN items i ON i.id = u.item_id
     WHERE i.status = 'active'`,
  );
  const b = base.rows[0];
  const baseline: number | null =
    b && Number(b["verdicts"]) > 0 ? Number(b["succ"]) / Number(b["verdicts"]) : null;

  const avgActiveBodyLen = await pool.query(
    `SELECT avg(length(body))::float AS avg FROM items WHERE status = 'active'`,
  );
  const avgLen = avgActiveBodyLen.rows[0]?.["avg"] as number | null | undefined;

  const verdicts: CanaryVerdict[] = [];
  for (const row of canaries.rows) {
    const itemId = row["id"] as string;
    // Момент входа в canary: последний promote-decision (переход в canary — promote).
    const startRes = await pool.query(
      `SELECT max(created_at) AS start FROM decisions WHERE item_id = $1 AND kind = 'promote'`,
      [itemId],
    );
    const startVal = startRes.rows[0]?.["start"];
    const canaryStart = startVal ? new Date(startVal as Date | string) : new Date(row["updated_at"] as string);
    const daysInCanary = (now.getTime() - canaryStart.getTime()) / DAY_MS;
    const windowDays = config.canary.window_days;

    const usageRes = await pool.query(
      `SELECT count(*)::int AS used,
              count(*) FILTER (WHERE task_success)::int AS succ,
              count(*) FILTER (WHERE task_success IS NOT NULL)::int AS verdicts
       FROM usage_log WHERE item_id = $1 AND retrieved_at >= $2`,
      [itemId, canaryStart.toISOString()],
    );
    const u = usageRes.rows[0];
    const used = Number(u["used"]);
    const verdictsCount = Number(u["verdicts"]);

    const evidence: Record<string, unknown> = {
      window_days: windowDays,
      days_in_canary: Number(daysInCanary.toFixed(2)),
      used,
      baseline,
      epsilon: config.canary_epsilon,
    };

    if (daysInCanary < windowDays) {
      verdicts.push({
        itemId,
        title: row["title"] as string,
        outcome: "hold",
        reason: `окно canary не истекло: ${daysInCanary.toFixed(1)}д < ${windowDays}д`,
        evidence,
      });
      continue;
    }
    if (used < config.canary.min_retrievals) {
      verdicts.push({
        itemId,
        title: row["title"] as string,
        outcome: "hold",
        reason: `недостаточно извлечений: ${used} < ${config.canary.min_retrievals} (окно продлевается)`,
        evidence,
      });
      continue;
    }
    if (verdictsCount === 0) {
      verdicts.push({
        itemId,
        title: row["title"] as string,
        outcome: "hold",
        reason: "нет вердиктов верификатора (task_success не заполнен)",
        evidence,
      });
      continue;
    }

    const successRate = Number(u["succ"]) / verdictsCount;
    evidence["success_rate"] = Number(successRate.toFixed(4));

    // Cost-gate (ТЗ §9.1): M2-прокси стоимости — длина тела vs среднее по active.
    let costRatio: number | null = null;
    if (avgLen != null && avgLen > 0) {
      costRatio = (row["body"] as string).length / avgLen;
      evidence["cost_ratio"] = Number(costRatio.toFixed(3));
      if (costRatio > config.canary.cost_multiplier_max) {
        const reason = `cost-gate: стоимость ${costRatio.toFixed(2)}× > ${config.canary.cost_multiplier_max}× baseline (ТЗ §9.1)`;
        await store.applyTransition(itemId, {
          to: "candidate",
          kind: "reject",
          actor: "auto:canary",
          reason,
          evidence: evidence as Readonly<Record<string, unknown>>,
        });
        verdicts.push({ itemId, title: row["title"] as string, outcome: "demote", reason, evidence });
        continue;
      }
    }

    const threshold = baseline != null ? baseline - config.canary_epsilon : 1 - config.canary_epsilon;
    evidence["threshold"] = Number(threshold.toFixed(4));
    if (successRate >= threshold) {
      const reason = `canary-pass: success_rate ${successRate.toFixed(2)} ≥ порог ${threshold.toFixed(2)} (baseline−ε)`;
      await store.applyTransition(itemId, {
        to: "active",
        kind: "promote",
        actor: "auto:canary",
        reason,
        evidence: evidence as Readonly<Record<string, unknown>>,
      });
      verdicts.push({ itemId, title: row["title"] as string, outcome: "promote", reason, evidence });
    } else {
      const reason = `canary-fail: success_rate ${successRate.toFixed(2)} < порог ${threshold.toFixed(2)} → flag, повтор новым кандидатом`;
      await store.applyTransition(itemId, {
        to: "candidate",
        kind: "reject",
        actor: "auto:canary",
        reason,
        evidence: evidence as Readonly<Record<string, unknown>>,
      });
      verdicts.push({ itemId, title: row["title"] as string, outcome: "demote", reason, evidence });
    }
  }
  return verdicts;
}
