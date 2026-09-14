import type { Pool } from "pg";
import type { EvolveConfig } from "../config/config.js";

/**
 * Score по (item, agent) из usage_log (М2, ТЗ §11.3, §7.2.4):
 *   score = w1·success_rate + w2·usage_norm + w3·recency
 *   success_rate — только при used ≥ min_used (иначе score = NULL: нет сигнала);
 *   без вердиктов верификатора — success_rate = 0.5 (нейтрально, задокументировано);
 *   usage_norm = min(1, used / min_used);
 *   recency = max(0, 1 − дней с последнего использования / 21) (decay 21д, ТЗ §19).
 * Источник правды — usage_log: пересчёт идемпотентный, score не правится вручную.
 */

export interface UsageStats {
  readonly used: number;
  readonly successCount: number;
  readonly verdictCount: number;
  readonly lastUsedAt: string | null; // ISO-8601
}

export interface AgentScoreResult {
  /** NULL, пока used < min_used (нет сигнала) — вызывающий делает fallback на score_global. */
  readonly score: number | null;
  readonly components: {
    readonly success_rate: number | null;
    readonly usage_norm: number;
    readonly recency: number;
    readonly used: number;
  };
}

const DAY_MS = 86_400_000;
const RECENCY_HALF_DAYS = 21; // decay 21д (config.degradation.unused_days)

export function computeAgentScore(config: EvolveConfig, stats: UsageStats, now: Date): AgentScoreResult {
  const w = config.score;
  const used = stats.used;
  const usageNorm = Math.min(1, used / w.min_used);
  const daysSinceLastUse =
    stats.lastUsedAt == null ? null : Math.max(0, (now.getTime() - new Date(stats.lastUsedAt).getTime()) / DAY_MS);
  const recency = daysSinceLastUse == null ? 0 : Math.max(0, 1 - daysSinceLastUse / RECENCY_HALF_DAYS);

  if (used < w.min_used) {
    return { score: null, components: { success_rate: null, usage_norm: usageNorm, recency, used } };
  }
  const successRate =
    stats.verdictCount > 0 ? stats.successCount / stats.verdictCount : 0.5; // без вердиктов — нейтрально
  const raw =
    w.success_rate_weight * successRate + w.usage_norm_weight * usageNorm + w.recency_weight * recency;
  return {
    score: Math.min(1, Math.max(0, raw)),
    components: { success_rate: successRate, usage_norm: usageNorm, recency, used },
  };
}

/** Идемпотентный пересчёт всех score по (item, agent) + score_global. */
export async function recomputeScores(pool: Pool, config: EvolveConfig, now: Date): Promise<number> {
  const res = await pool.query(
    `SELECT u.item_id, u.agent_id,
            count(*)::int AS used,
            count(*) FILTER (WHERE u.task_success)::int AS succ,
            count(*) FILTER (WHERE u.task_success IS NOT NULL)::int AS verdicts,
            max(u.retrieved_at) AS last_used
     FROM usage_log u
     JOIN items i ON i.id = u.item_id
     WHERE i.status <> 'archived'
     GROUP BY 1, 2`,
  );
  let n = 0;
  for (const r of res.rows) {
    const outcome = computeAgentScore(
      config,
      {
        used: Number(r["used"]),
        successCount: Number(r["succ"]),
        verdictCount: Number(r["verdicts"]),
        lastUsedAt: r["last_used"] == null ? null : (r["last_used"] as Date).toISOString(),
      },
      now,
    );
    await pool.query(
      `INSERT INTO item_scores (item_id, agent_id, score, used, components, computed_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (item_id, agent_id) DO UPDATE
         SET score = EXCLUDED.score, used = EXCLUDED.used,
             components = EXCLUDED.components, computed_at = now()`,
      [r["item_id"], r["agent_id"], outcome.score, outcome.components.used, JSON.stringify(outcome.components)],
    );
    n += 1;
  }
  // Пары (item, agent) без usage — удаляем (таблица — производная от usage_log).
  await pool.query(
    `DELETE FROM item_scores
     WHERE (item_id, agent_id) NOT IN (SELECT item_id, agent_id FROM usage_log GROUP BY 1, 2)`,
  );
  // score_global — среднее по агентам (только где есть сигнал).
  await pool.query(
    `UPDATE items i SET score_global = COALESCE(s.avg, 0)
     FROM (SELECT item_id, avg(score) AS avg FROM item_scores WHERE score IS NOT NULL GROUP BY 1) s
     WHERE i.id = s.item_id AND i.status IN ('active', 'canary', 'queued', 'deprecated')`,
  );
  return n;
}

/** Чтение score для ранжирования: per-agent с fallback на score_global (ТЗ §10.1). */
export async function itemScoreFor(
  pool: Pool,
  itemId: string,
  agentId: string,
): Promise<{ score: number; source: "agent" | "global" }> {
  const res = await pool.query(
    `SELECT s.score, i.score_global FROM items i LEFT JOIN item_scores s
     ON s.item_id = i.id AND s.agent_id = $2 WHERE i.id = $1`,
    [itemId, agentId],
  );
  const row = res.rows[0];
  if (!row) {
    return { score: 0, source: "global" };
  }
  if (row["score"] != null) {
    return { score: Number(row["score"]), source: "agent" };
  }
  return { score: Number(row["score_global"] ?? 0), source: "global" };
}
