import type { Pool } from "pg";
import type { EvolveConfig } from "../config/config.js";

/**
 * Недельный отчёт (M3, ТЗ §12/§15 M3: «недельное окно ≤ 20 минут»):
 * сводка за 7 дней — success-rate по агентам, canary-итоги, churn (демоции),
 * застой очереди + алерты по config.alerts (ТЗ §12.2: «только сигналы,
 * иначе система молчит»). Прокси стоимости (М3, задокументировано):
 * токены/задачу ≈ средняя длина inject-тел на задачу.
 */

const DAY_MS = 86_400_000;

export interface AgentSuccess {
  readonly agentId: string;
  readonly tasks: number;
  readonly verdicts: number;
  readonly successes: number;
  readonly successRate: number | null; // null — нет вердиктов
}

export interface WeeklyReport {
  readonly windowStart: string; // ISO
  readonly windowEnd: string; // ISO
  readonly successByAgent: readonly AgentSuccess[];
  readonly canary: { readonly promoted: readonly string[]; readonly demoted: readonly string[] };
  readonly churn: {
    readonly demotes: number;
    readonly archives: number;
    readonly items: readonly { readonly id: string; readonly title: string; readonly kind: string }[];
  };
  readonly queueAged: readonly { readonly id: string; readonly title: string; readonly days: number }[];
  /** Пустой массив = «система молчит» (ТЗ §12.2). */
  readonly alerts: readonly { readonly code: string; readonly message: string }[];
}

function iso(d: Date): string {
  return d.toISOString();
}

export async function buildWeeklyReport(pool: Pool, config: EvolveConfig, now: Date): Promise<WeeklyReport> {
  const start = new Date(now.getTime() - 7 * DAY_MS);
  const prevStart = new Date(now.getTime() - 14 * DAY_MS);

  // --- success-rate по агентам за окно ---
  const agentRows = await pool.query(
    `SELECT agent_id,
            count(DISTINCT task_id)::int AS tasks,
            count(*)::int AS verdicts,
            count(*) FILTER (WHERE task_success)::int AS succ
     FROM usage_log
     WHERE task_success IS NOT NULL AND retrieved_at >= $1
     GROUP BY agent_id ORDER BY agent_id`,
    [iso(start)],
  );
  const successByAgent: AgentSuccess[] = agentRows.rows.map((r) => {
    const verdicts = Number(r["verdicts"]);
    return {
      agentId: r["agent_id"] as string,
      tasks: Number(r["tasks"]),
      verdicts,
      successes: Number(r["succ"]),
      successRate: verdicts > 0 ? Number(r["succ"]) / verdicts : null,
    };
  });

  // --- canary-итоги (решения auto:canary за окно) ---
  const canaryRes = await pool.query(
    `SELECT d.item_id, d.kind, i.title FROM decisions d JOIN items i ON i.id = d.item_id
     WHERE d.actor = 'auto:canary' AND d.created_at >= $1`,
    [iso(start)],
  );
  const canary = { promoted: [] as string[], demoted: [] as string[] };
  for (const r of canaryRes.rows) {
    const entry = `${r["title"]} (${(r["item_id"] as string).slice(0, 8)}…)`;
    if (r["kind"] === "promote") {
      canary.promoted.push(entry);
    } else {
      canary.demoted.push(entry);
    }
  }

  // --- churn: демоции/архивации auto:degradation за окно ---
  const churnRes = await pool.query(
    `SELECT d.item_id, d.kind, i.title FROM decisions d JOIN items i ON i.id = d.item_id
     WHERE d.actor = 'auto:degradation' AND d.created_at >= $1
     ORDER BY d.created_at`,
    [iso(start)],
  );
  const churn = { demotes: 0, archives: 0, items: [] as { id: string; title: string; kind: string }[] };
  for (const r of churnRes.rows) {
    if (r["kind"] === "demote") {
      churn.demotes += 1;
    } else {
      churn.archives += 1;
    }
    churn.items.push({ id: r["item_id"] as string, title: r["title"] as string, kind: r["kind"] as string });
  }

  // --- застой очереди: > queue_card_max_days в queue ---
  const agedRes = await pool.query(
    `SELECT i.id, i.title,
            floor(EXTRACT(EPOCH FROM (now() - min(d.created_at))) / 86400)::int AS days
     FROM items i
     JOIN decisions d ON d.item_id = i.id AND d.kind = 'demote'
     WHERE i.status = 'queued'
     GROUP BY i.id, i.title
     HAVING floor(EXTRACT(EPOCH FROM (now() - min(d.created_at))) / 86400) > $1`,
    [config.alerts.queue_card_max_days],
  );
  const queueAged: { id: string; title: string; days: number }[] = agedRes.rows.map((r) => ({
    id: r["id"] as string,
    title: r["title"] as string,
    days: Number(r["days"]),
  }));

  // --- алерты (ТЗ §12.2: только сигналы) ---
  const alerts: { code: string; message: string }[] = [];
  const a = config.alerts;

  const activeCount = await pool.query(`SELECT count(*)::int AS n FROM items WHERE status = 'active'`);
  const nActive = Number(activeCount.rows[0]["n"]);
  if (nActive / config.budget.active_max > a.active_budget_ratio) {
    alerts.push({
      code: "active_budget",
      message: `active ${nActive} — ${((100 * nActive) / config.budget.active_max).toFixed(0)}% бюджета (${config.budget.active_max})`,
    });
  }

  const openContr = await pool.query(`SELECT count(*)::int AS n FROM contradictions WHERE status = 'open'`);
  const nOpen = Number(openContr.rows[0]["n"]);
  if (nOpen > a.open_contradictions_max) {
    alerts.push({ code: "open_contradictions", message: `открытых противоречий: ${nOpen} > ${a.open_contradictions_max}` });
  }

  // success-rate drop: текущие 14д против предыдущих 14д (ТЗ §12.2: −5% при росте базы).
  const curSr = await pool.query(
    `SELECT count(*)::int AS verdicts, count(*) FILTER (WHERE task_success)::int AS succ
     FROM usage_log WHERE task_success IS NOT NULL AND retrieved_at >= $1`,
    [iso(prevStart)],
  );
  const prevSr = await pool.query(
    `SELECT count(*)::int AS verdicts, count(*) FILTER (WHERE task_success)::int AS succ
     FROM usage_log WHERE task_success IS NOT NULL AND retrieved_at >= $1 AND retrieved_at < $2`,
    [iso(new Date(now.getTime() - 28 * DAY_MS)), iso(prevStart)],
  );
  const curVerdicts = Number(curSr.rows[0]["verdicts"]);
  const prevVerdicts = Number(prevSr.rows[0]["verdicts"]);
  if (curVerdicts > 0 && prevVerdicts > 0) {
    const cur = Number(curSr.rows[0]["succ"]) / curVerdicts;
    const prev = Number(prevSr.rows[0]["succ"]) / prevVerdicts;
    // «при росте базы» (М3-приближение): база была непустой до окна.
    const baseBefore = await pool.query(
      `SELECT count(*)::int AS n FROM items WHERE created_at < $1`,
      [iso(prevStart)],
    );
    if (Number(baseBefore.rows[0]["n"]) > 0 && prev - cur >= a.success_rate_drop) {
      alerts.push({
        code: "success_rate_drop",
        message: `success-rate: ${prev.toFixed(2)} → ${cur.toFixed(2)} (Δ −${(100 * (prev - cur)).toFixed(1)}% за 2 нед при росте базы)`,
      });
    }
  }

  if (churn.demotes > a.churn_demos_per_week_max) {
    alerts.push({
      code: "churn",
      message: `demotion за неделю: ${churn.demotes} > ${a.churn_demos_per_week_max} (2 недели подряд → пересмотр порогов)`,
    });
  }

  if (queueAged.length > 0) {
    alerts.push({
      code: "queue_card_aged",
      message: `в queue > ${a.queue_card_max_days}д: ${queueAged.map((q) => `${q.title} (${q.days}д)`).join(", ")}`,
    });
  }

  // cost-growth (М3-прокси): средняя длина inject-тел на задачу за неделю против предыдущей.
  const costCur = await pool.query(
    `SELECT avg(length(i.body))::float AS avg FROM usage_log u JOIN items i ON i.id = u.item_id
     WHERE u.retrieved_at >= $1`,
    [iso(start)],
  );
  const costPrev = await pool.query(
    `SELECT avg(length(i.body))::float AS avg FROM usage_log u JOIN items i ON i.id = u.item_id
     WHERE u.retrieved_at >= $1 AND u.retrieved_at < $2`,
    [iso(prevStart), iso(start)],
  );
  const cCur = costCur.rows[0]?.["avg"] as number | null | undefined;
  const cPrev = costPrev.rows[0]?.["avg"] as number | null | undefined;
  if (cCur != null && cPrev != null && cPrev > 0 && cCur / cPrev > 1 + a.cost_growth) {
    alerts.push({
      code: "cost_growth",
      message: `стоимость (M3-прокси: средняя длина тел/запрос): ${cPrev.toFixed(0)} → ${cCur.toFixed(0)} симв. (+${((100 * (cCur - cPrev)) / cPrev).toFixed(0)}%)`,
    });
  }

  return {
    windowStart: iso(start),
    windowEnd: iso(now),
    successByAgent,
    canary,
    churn,
    queueAged,
    alerts,
  };
}

/** Markdown-рендер (CLI по умолчанию). */
export function renderMarkdown(r: WeeklyReport): string {
  const lines: string[] = [];
  lines.push(`# Недельный отчёт evolve (${r.windowStart.slice(0, 10)} → ${r.windowEnd.slice(0, 10)})`);
  lines.push("");
  lines.push("## Success-rate по агентам");
  if (r.successByAgent.length === 0) {
    lines.push("- вердиктов за окно нет");
  }
  for (const a of r.successByAgent) {
    const sr = a.successRate == null ? "н/д" : `${(100 * a.successRate).toFixed(1)}%`;
    lines.push(`- ${a.agentId}: success ${sr} (вердиктов ${a.verdicts}, задач ${a.tasks})`);
  }
  lines.push("");
  lines.push("## Canary (auto-решения за неделю)");
  if (r.canary.promoted.length === 0 && r.canary.demoted.length === 0) {
    lines.push("- решений нет");
  }
  for (const p of r.canary.promoted) {
    lines.push(`- ↑ promoted: ${p}`);
  }
  for (const d of r.canary.demoted) {
    lines.push(`- ↓ demoted: ${d}`);
  }
  lines.push("");
  lines.push(`## Churn (demotion: ${r.churn.demotes}, archive: ${r.churn.archives})`);
  if (r.churn.items.length === 0) {
    lines.push("- демоций за неделю нет");
  }
  for (const c of r.churn.items) {
    lines.push(`- [${c.kind}] ${c.title} (${c.id.slice(0, 8)}…)`);
  }
  lines.push("");
  lines.push("## Застой очереди");
  if (r.queueAged.length === 0) {
    lines.push("- нет");
  }
  for (const q of r.queueAged) {
    lines.push(`- ${q.title} (${q.days}д в queue)`);
  }
  lines.push("");
  lines.push("## Алерты (ТЗ §12.2: только сигналы)");
  if (r.alerts.length === 0) {
    lines.push("- нет (система молчит)");
  }
  for (const al of r.alerts) {
    lines.push(`- [${al.code}] ${al.message}`);
  }
  return lines.join("\n");
}

