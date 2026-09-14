import type { EvolveConfig } from "../config/config.js";
import type { PgStore } from "../store/pg-store.js";

/**
 * Авто-вес критика (M4.2, ТЗ §13/§15 M4): «ложные issues снижают вес критика
 * механически (critic_weight, авто-пересчёт еженедельно)».
 *
 * weight = base × gate_quality × usage_factor, где (формула задокументирована):
 *   base = config.critic.weight (1.0);
 *   gate_quality = 0.5 + 0.5 × gate_pass_rate (1.0, если lesson-кандидатов нет):
 *     gate_pass_rate = доля lesson-кандидатов критика, прошедших конвейер
 *     (стали item-ами; merge/reject — не прошли);
 *   usage_factor:
 *     меньше min_verdicts (5) вердиктов на задачах, где использовались
 *     lesson-элементы критика → 1.0 (нет сигнала);
 *     иначе clamp(critic_sr / baseline_sr, 0.5, 1.5) — success-rate использования
 *     lesson-элементов критика против общего success-rate;
 *   итог: clamp(·, 0.1, 2.0). Пересчёт идемпотентный (таблица — производная
 *   от телеметрии); новое review-решение использует последний пересчитанный вес.
 */

export interface CriticStats {
  readonly previousWeight: number | null;
  readonly weight: number;
  readonly gatePassRate: number | null;
  readonly usageFactor: number;
  readonly lessons: number;
  readonly accepted: number;
  readonly criticVerdicts: number;
  readonly criticSuccessRate: number | null;
  readonly baselineSuccessRate: number | null;
}

const MIN_VERDICTS = 5;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export async function recomputeCriticWeight(
  store: PgStore,
  config: EvolveConfig,
  now: Date,
): Promise<CriticStats> {
  const pool = store.pool;

  const prev = await pool.query(`SELECT weight FROM critic_weights WHERE source_id = 'critic'`);
  const previousWeight: number | null = prev.rows[0]?.["weight"] != null ? Number(prev.rows[0]["weight"]) : null;

  // lesson-кандидаты критика: issues c lesson_candidate в review_recorded (source=critic).
  const lessonsRes = await pool.query(
    `SELECT count(*)::int AS n FROM (
       SELECT jsonb_array_elements(e.payload->'issues') AS issue
       FROM events e
       WHERE e.event_type = 'review_recorded' AND e.payload->>'source' = 'critic'
     ) t WHERE t.issue ? 'lesson_candidate'`,
  );
  const lessons = Number(lessonsRes.rows[0]["n"]);

  // принятые: item-ы с провенансом critic (lesson прошёл конвейер).
  const acceptedRes = await pool.query(
    `SELECT count(DISTINCT p.item_id)::int AS n FROM provenance p WHERE p.source_type = 'critic'`,
  );
  const accepted = Number(acceptedRes.rows[0]["n"]);
  const gatePassRate: number | null = lessons > 0 ? accepted / lessons : null;
  const gateQuality = gatePassRate == null ? 1.0 : 0.5 + 0.5 * gatePassRate;

  // usage-фактор: success на задачах, где использовались lesson-элементы критика.
  const criticUsage = await pool.query(
    `SELECT count(*) FILTER (WHERE u.task_success)::int AS succ,
            count(*) FILTER (WHERE u.task_success IS NOT NULL)::int AS verdicts
     FROM usage_log u
     JOIN items i ON i.id = u.item_id
     JOIN provenance p ON p.item_id = i.id AND p.source_type = 'critic'`,
  );
  const overall = await pool.query(
    `SELECT count(*) FILTER (WHERE u.task_success)::int AS succ,
            count(*) FILTER (WHERE u.task_success IS NOT NULL)::int AS verdicts
     FROM usage_log u`,
  );
  const cu = criticUsage.rows[0];
  const cuVerdicts = Number(cu["verdicts"]);
  const cuSucc = Number(cu["succ"]);
  const criticSuccessRate = cuVerdicts > 0 ? cuSucc / cuVerdicts : null;
  const ovVerdicts = Number(overall.rows[0]["verdicts"]);
  const baselineSuccessRate =
    ovVerdicts > 0 ? Number(overall.rows[0]["succ"]) / ovVerdicts : null;

  let usageFactor = 1.0;
  if (cuVerdicts >= MIN_VERDICTS && baselineSuccessRate != null) {
    usageFactor =
      baselineSuccessRate > 0 ? clamp(criticSuccessRate! / baselineSuccessRate, 0.5, 1.5) : 1.5;
  }

  const weight = clamp(config.critic.weight * gateQuality * usageFactor, 0.1, 2.0);
  await pool.query(
    `INSERT INTO critic_weights (source_id, weight, gate_pass_rate, usage_factor, lessons, accepted, computed_at)
     VALUES ('critic', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id) DO UPDATE
       SET weight = EXCLUDED.weight, gate_pass_rate = EXCLUDED.gate_pass_rate,
           usage_factor = EXCLUDED.usage_factor, lessons = EXCLUDED.lessons,
           accepted = EXCLUDED.accepted, computed_at = EXCLUDED.computed_at`,
    [weight, gatePassRate, usageFactor, lessons, accepted, now.toISOString()],
  );

  return {
    previousWeight,
    weight,
    gatePassRate,
    usageFactor,
    lessons,
    accepted,
    criticVerdicts: cuVerdicts,
    criticSuccessRate,
    baselineSuccessRate,
  };
}

/** Последний пересчитанный вес (null — пересчёта ещё не было). */
export async function latestCriticWeight(pool: PgStore["pool"]): Promise<number | null> {
  const res = await pool.query(`SELECT weight FROM critic_weights WHERE source_id = 'critic'`);
  return res.rows[0]?.["weight"] != null ? Number(res.rows[0]["weight"]) : null;
}
