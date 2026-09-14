import type { EvolveConfig } from "../config/config.js";
import type { PgStore } from "../store/pg-store.js";

/**
 * Decay / деградация (M3, ТЗ §9 + config.degradation; защита от over-pruning — ТЗ §16):
 *  1) unused: активный элемент без использования ≥ unused_days (21) → deprecated;
 *     + score_global < θ_score при used ≥ min_usage_for_demote → deprecated;
 *  2) archived: deprecated ≥ deprecated_to_archived_days (30) → archived
 *     (archived_reason обязателен — ТЗ §7.2.1);
 *  3) contradiction: открытое противоречие старше open_contradiction_days (7)
 *     → активные участники → queued (ТЗ §9);
 *  4) over-pruning guard: не более max_deprecated_share_per_month (0.2) × active
 *     demotion за календарный месяц (М3-приближение, задокументировано).
 * Все решения — actor='auto:degradation', аудит в decisions;
 * rollback — один клик (ТЗ §15 M3): команда `evolve rollback <id>`.
 */

export type DecayActionKind = "demote" | "archive" | "queue_contradiction" | "skipped_guard";

export interface DecayAction {
  readonly itemId: string;
  readonly title: string;
  readonly kind: DecayActionKind;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

const DAY_MS = 86_400_000;

export async function runDecay(
  store: PgStore,
  config: EvolveConfig,
  now: Date,
): Promise<DecayAction[]> {
  const pool = store.pool;
  const actions: DecayAction[] = [];
  const d = config.degradation;

  // Базовый знаменатель guard — вся неархивированная база (М3-приближение,
  // задокументировано): доля demotion от всей базы знаний за месяц.
  const baseRes = await pool.query(`SELECT count(*)::int AS n FROM items WHERE status <> 'archived'`);
  const nBase = Number(baseRes.rows[0]["n"]);

  // (4) over-pruning guard: сколько demotion уже было в текущем календарном месяце.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const demotedThisMonth = await pool.query(
    `SELECT count(*)::int AS n FROM decisions
     WHERE actor = 'auto:degradation' AND kind = 'demote' AND created_at >= $1`,
    [monthStart],
  );
  const guardLimit = Math.floor(d.max_deprecated_share_per_month * nBase);
  let demotionsLeft = guardLimit - Number(demotedThisMonth.rows[0]["n"]);

  // (1a) unused: нет использования ≥ unused_days (активность = max(последний usage, updated_at)).
  if (demotionsLeft > 0) {
    // Активность = max(последний usage, created_at): created_at имutable (триггер
    // обнуляет updated_at), young-элементы без usage не вымываются (grace-период).
    const stale = await pool.query(
      `SELECT i.id, i.title, i.created_at, max(u.retrieved_at) AS last_use
       FROM items i LEFT JOIN usage_log u ON u.item_id = i.id
       WHERE i.status = 'active'
       GROUP BY i.id, i.created_at
       HAVING max(GREATEST(coalesce(u.retrieved_at, i.created_at), i.created_at))
              <= now() - ($1 || ' days')::interval`,
      [String(d.unused_days)],
    );
    for (const row of stale.rows) {
      if (demotionsLeft <= 0) {
        actions.push({
          itemId: row["id"] as string,
          title: row["title"] as string,
          kind: "skipped_guard",
          reason: "over-pruning guard: лимит demotion за месяц исчерпан (ТЗ §16)",
          evidence: { demoted_this_month: Number(demotedThisMonth.rows[0]["n"]), limit: guardLimit },
        });
        continue;
      }
      const last = row["last_use"] ?? row["created_at"];
      const days = (now.getTime() - new Date(last as Date | string).getTime()) / DAY_MS;
      const reason = `decay: ${days.toFixed(0)}д без использования (порог ${d.unused_days}д)`;
      await store.applyTransition(row["id"], {
        to: "deprecated",
        kind: "demote",
        actor: "auto:degradation",
        reason,
        evidence: { rule: "unused_days", days_idle: Number(days.toFixed(1)), threshold_days: d.unused_days },
      });
      demotionsLeft -= 1;
      actions.push({
        itemId: row["id"] as string,
        title: row["title"] as string,
        kind: "demote",
        reason,
        evidence: { days_idle: Number(days.toFixed(1)) },
      });
    }
  }

  // (1b) score: score_global < θ_score при used ≥ min_usage_for_demote.
  if (demotionsLeft > 0) {
    const lowScore = await pool.query(
      `SELECT i.id, i.title, i.score_global, count(u.id)::int AS used
       FROM items i LEFT JOIN usage_log u ON u.item_id = i.id
       WHERE i.status = 'active'
       GROUP BY i.id
       HAVING i.score_global < $1 AND count(u.id) >= $2`,
      [config.theta_score, d.min_usage_for_demote],
    );
    for (const row of lowScore.rows) {
      if (demotionsLeft <= 0) {
        continue;
      }
      const score = Number(row["score_global"]);
      const used = Number(row["used"]);
      const reason = `decay: score_global ${score.toFixed(2)} < θ_score ${config.theta_score} (used=${used})`;
      await store.applyTransition(row["id"], {
        to: "deprecated",
        kind: "demote",
        actor: "auto:degradation",
        reason,
        evidence: { rule: "theta_score", score, used, theta: config.theta_score },
      });
      demotionsLeft -= 1;
      actions.push({
        itemId: row["id"] as string,
        title: row["title"] as string,
        kind: "demote",
        reason,
        evidence: { score, used },
      });
    }
  }

  // (2) deprecated ≥ 30 дней → archived (archived_reason обязателен, ТЗ §7.2.1).
  // Время в deprecated — created_at последнего demote-решения (updated_at обнуляется триггером).
  const oldDep = await pool.query(
    `SELECT i.id, i.title FROM items i
     JOIN (SELECT item_id, max(created_at) AS dep_at FROM decisions
           WHERE kind = 'demote' GROUP BY item_id) dd ON dd.item_id = i.id
     WHERE i.status = 'deprecated' AND dd.dep_at <= now() - ($1 || ' days')::interval`,
    [String(d.deprecated_to_archived_days)],
  );
  for (const row of oldDep.rows) {
    const reason = `decay: ${d.deprecated_to_archived_days}д без восстановления в deprecated (ТЗ §9)`;
    await store.applyTransition(row["id"], {
      to: "archived",
      kind: "archive",
      actor: "auto:degradation",
      reason,
      archivedReason: reason,
      evidence: { rule: "deprecated_to_archived_days" },
    });
    actions.push({ itemId: row["id"] as string, title: row["title"] as string, kind: "archive", reason, evidence: {} });
  }

  // (3) открытые противоречия старше 7 дней → активные участники в queue (ТЗ §9).
  const oldContr = await pool.query(
    `SELECT c.id, c.item_a_id, c.item_b_id FROM contradictions c
     WHERE c.status = 'open' AND c.created_at <= now() - ($1 || ' days')::interval`,
    [String(d.open_contradiction_days)],
  );
  for (const row of oldContr.rows) {
    for (const col of ["item_a_id", "item_b_id"]) {
      const item = await pool.query(`SELECT id, title, status FROM items WHERE id = $1`, [row[col]]);
      if (item.rows[0]?.["status"] !== "active") {
        continue; // только активные (canary → queue ребром не предусмотрено, М3)
      }
      const reason = `decay: открытое противоречие ${row["id"].slice(0, 8)}… старше ${d.open_contradiction_days}д (ТЗ §9)`;
      await store.applyTransition(row[col], {
        to: "queued",
        kind: "demote",
        actor: "auto:degradation",
        reason,
        evidence: { rule: "open_contradiction_days", contradiction_id: row["id"] },
      });
      actions.push({
        itemId: row[col] as string,
        title: item.rows[0]["title"] as string,
        kind: "queue_contradiction",
        reason,
        evidence: { contradiction_id: row["id"] },
      });
    }
  }

  return actions;
}
