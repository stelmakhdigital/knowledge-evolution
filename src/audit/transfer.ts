import type { EvolveConfig } from "../config/config.js";
import type { LlmClient } from "../llm/client.js";
import { retrieve } from "../retrieval/search.js";
import type { PgStore } from "../store/pg-store.js";

/**
 * Transfer-тест (M5.2, ТЗ §14.5): «в canary-окне репрезентативная подвыборка
 * (top-20 по importance) прогоняется как минимум на альтернативном
 * agent_profile; элементы, стабильно работающие только на одном профиле →
 * тег transfer:weak (не блокирует active, но попадает в месячный аудит)».
 *
 * M5-приближения (задокументированы):
 *  - importance = (usage-подсчёт, score_global) — топ-20 активных элементов;
 *  - «прогон на профиле» = self-recall: реальный retrieve() (hybrid, budget-гварды)
 *    с запросом «title + tags» на альтернативном profile — элемент должен быть
 *    в выдаче этого профиля;
 *  - applies_to=<другой агент> — по ТЗ §14.3 такое знание и не должно
 *    переноситься (поведенческий урок про специфику модели) → verdict
 *    transfer:weak (информационный тег, не блокировка);
 *  - применим, но не в выдаче (scope-сужение/шум) → weak.
 */

export type TransferVerdict = "transferred" | "weak_excluded" | "weak_not_retrieved";

export interface TransferResult {
  readonly itemId: string;
  readonly title: string;
  readonly appliesTo: string;
  readonly applicable: boolean;
  readonly inRetrieval: boolean;
  readonly verdict: TransferVerdict;
  readonly weakTagged: boolean;
}

export interface TransferSummary {
  readonly profileAgent: string;
  readonly total: number;
  readonly transferred: number;
  readonly weak: number;
  readonly results: readonly TransferResult[];
}

export async function runTransferEval(
  store: PgStore,
  config: EvolveConfig,
  llm: LlmClient,
  now: Date,
  profileAgent: string,
  limit = 20,
): Promise<TransferSummary> {
  const pool = store.pool;

  // Профиль должен существовать (hard: harness исполним в профилях ≥ 2 моделей).
  const profile = await pool.query(`SELECT agent_id FROM agent_profiles WHERE agent_id = $1`, [profileAgent]);
  if (profile.rows.length === 0) {
    throw new Error(
      `agent_profile '${profileAgent}' не найден — создайте профиль (transfer-тест, ТЗ §14.5)`,
    );
  }

  // top-20 по importance: usage-подсчёт, затем score_global.
  const top = await pool.query(
    `SELECT i.id, i.title, i.applies_to, i.tags, count(u.id)::int AS usages
     FROM items i LEFT JOIN usage_log u ON u.item_id = i.id
     WHERE i.status = 'active'
     GROUP BY i.id, i.title, i.applies_to, i.tags
     ORDER BY usages DESC, i.score_global DESC, i.created_at
     LIMIT $1`,
    [limit],
  );

  const results: TransferResult[] = [];
  for (const row of top.rows) {
    const itemId = row["id"] as string;
    const title = row["title"] as string;
    const appliesTo = row["applies_to"] as string;
    const tags = row["tags"] as readonly string[];
    const applicable = appliesTo === "all" || appliesTo === profileAgent;

    const query = [title, ...tags].join(" ").trim();
    const res = await retrieve(pool, { query, agentId: profileAgent }, config, llm, now);
    const inRetrieval = res.items.some((r) => r.item.id === itemId);

    let verdict: TransferVerdict;
    let weakTagged = false;
    if (applicable && inRetrieval) {
      verdict = "transferred";
    } else {
      verdict = applicable ? "weak_not_retrieved" : "weak_excluded";
      await store.addTag(itemId, "transfer:weak");
      weakTagged = true;
    }
    results.push({ itemId, title, appliesTo, applicable, inRetrieval, verdict, weakTagged });
  }

  return {
    profileAgent,
    total: results.length,
    transferred: results.filter((r) => r.verdict === "transferred").length,
    weak: results.filter((r) => r.verdict !== "transferred").length,
    results,
  };
}
