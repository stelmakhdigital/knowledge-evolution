import type { Pool } from "pg";
import type { EvolveConfig } from "../config/config.js";
import { hashBody } from "../domain/hashing.js";
import type { LlmClient } from "../llm/client.js";
import type { Item } from "../domain/types.js";

/**
 * Retrieval (M2, ТЗ §10.1/§10.3/§19): hybrid = keyword (FTS simple + pg_trgm)
 * + vector (pgvector, cos) → RRF-фьюжн → финальный ранк по весам config.retrieval:
 *   ranking = w1·rrf + w2·item_score + w3·scope_match − w4·recency_decay.
 * Budget-гварды обязательны: max_chars_per_item, max_total_recall_chars,
 * timeout_ms (по таймауту инъекция пропускается, задача не блокируется — ТЗ §19).
 * Извлекаются только active/canary (ТЗ §10.3); applies_to: 'all' | agent_id (ТЗ §14.2).
 */

export interface RetrieveRequest {
  readonly query: string;
  readonly agentId: string;
  /** Если задан — запись usage_log (знание было доступно ДО задачи, ТЗ §10.3). */
  readonly taskId?: string | undefined;
  readonly scopeHints?: readonly string[] | undefined;
}

export interface RetrievedItem {
  readonly item: Item;
  /** Тело после budget-обрезки. */
  readonly body: string;
  readonly channels: readonly string[];
  readonly finalScore: number;
}

export interface RetrieveResult {
  readonly items: readonly RetrievedItem[];
  readonly truncated: boolean;
  readonly tookMs: number;
  readonly timedOut: boolean;
}

interface ItemRow {
  id: string;
  type?: string;
  title: string;
  scope: string;
  tags: string[];
  body: string;
  version: number;
  score: number;
  created_at: Date;
}

const RETRIEVABLE_STATUSES = new Set(["active", "canary"]);

function isRetrievableStatus(status: string): boolean {
  return RETRIEVABLE_STATUSES.has(status);
}

/** Токены для FTS: только безопасные лексемы (без операторов tsquery). */
export function ftsTokens(query: string): string[] {
  return (query.toLowerCase().match(/[a-zа-яё0-9_]+/g) ?? []).filter((t) => t.length > 1);
}

/** Keyword-канал: FTS(simple) + trigram-сходство по title/scope/tags/body. */
export async function keywordSearch(
  pool: Pool,
  query: string,
  agentId: string,
  limit: number,
): Promise<string[]> {
  const tokens = ftsTokens(query);
  const tsquery = tokens.length > 0 ? tokens.join(" | ") : null;
  const sql = `
    SELECT id,
           (CASE WHEN $3::text IS NULL THEN 0
                 ELSE ts_rank(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,'')),
                               to_tsquery('simple', $3::text)) END)
           + 2.0 * similarity(coalesce(title,'') || ' ' || coalesce(scope,'') || ' ' || coalesce(ARRAY_TO_STRING(tags, ' '), ''), $1::text) AS s
    FROM items
    WHERE status IN ('active', 'canary')
      AND (applies_to = 'all' OR applies_to = $2)
    ORDER BY s DESC
    LIMIT $4`;
  const res = await pool.query(sql, [query, agentId, tsquery, limit]);
  return res.rows
    .filter((r) => Number(r["s"]) > 0)
    .map((r) => r["id"] as string);
}

/** Векторный канал: pgvector (cosine); ленивое индексирование версий. */
export async function vectorSearch(
  pool: Pool,
  queryVec: readonly number[],
  agentId: string,
  limit: number,
): Promise<string[]> {
  const res = await pool.query(
    `SELECT i.id, 1 - (e.vector <=> $1::vector) AS sim
     FROM items i
     JOIN embeddings e ON e.item_id = i.id AND e.version = i.version
     WHERE i.status IN ('active', 'canary')
       AND (i.applies_to = 'all' OR i.applies_to = $2)
     ORDER BY e.vector <=> $1::vector
     LIMIT $3`,
    [`[${queryVec.join(",")}]`, agentId, limit],
  );
  return res.rows.map((r) => r["id"] as string);
}

/** Ленивое индексирование: у версий без embedding считаем и пишем (детерминированная модель). */
export async function indexMissingEmbeddings(pool: Pool, llm: LlmClient): Promise<number> {
  const res = await pool.query(
    `SELECT i.id, i.version, i.body FROM items i
     LEFT JOIN embeddings e ON e.item_id = i.id AND e.version = i.version
     WHERE e.embedding_id IS NULL AND i.status IN ('active', 'canary')`,
  );
  let n = 0;
  for (const row of res.rows) {
    const vec = llm.embed(row["body"] as string);
    const embeddingId = `emb-${row["id"]}-${row["version"]}`;
    await pool.query(
      `INSERT INTO embeddings (embedding_id, item_id, version, vector, created_at)
       VALUES ($1,$2,$3,$4::vector, now())
       ON CONFLICT (embedding_id) DO NOTHING`,
      [embeddingId, row["id"], row["version"], `[${vec.join(",")}]`],
    );
    n += 1;
  }
  return n;
}

/** RRF-фьюжн (ТЗ §10.1): score(d) = Σ_канал 1/(k + rank_канал(d)). */
export function rrfFuse(channels: Record<string, readonly string[]>, k: number): Map<string, { score: number; channels: string[] }> {
  const out = new Map<string, { score: number; channels: string[] }>();
  for (const [name, ranked] of Object.entries(channels)) {
    ranked.forEach((id, rank) => {
      const entry = out.get(id) ?? { score: 0, channels: [] };
      entry.score += 1 / (k + rank + 1); // rank: 1-based
      entry.channels.push(name);
      out.set(id, entry);
    });
  }
  return out;
}

/**
 * Финальный ранк (config.retrieval.weights):
 *   w1·rrf(норм) + w2·item_score + w3·scope_match − w4·recency_decay.
 */
export function finalRank(
  fused: Map<string, { score: number; channels: string[] }>,
  items: Map<string, ItemRow>,
  config: EvolveConfig,
  scopeHints: readonly string[],
  now: Date,
): Array<{ id: string; score: number; channels: string[] }> {
  const w = config.retrieval.weights;
  const maxRrf = Math.max(0.0001, ...[...fused.values()].map((f) => f.score));
  const rows: Array<{ id: string; score: number; channels: string[] }> = [];
  for (const [id, f] of fused) {
    const it = items.get(id);
    if (!it) {
      continue;
    }
    const scopeMatch =
      scopeHints.some((h) => it.scope === h || h === it.scope) || scopeHints.length === 0 && it.scope === "all"
        ? 1
        : scopeHints.some((h) => h === it.scope)
          ? 1
          : 0;
    const ageDays = Math.max(0, (now.getTime() - it.created_at.getTime()) / 86_400_000);
    const recencyDecay = Math.min(1, ageDays / 30);
    const score =
      w.rrf_rank * (f.score / maxRrf) + w.item_score * it.score + w.scope_match * scopeMatch - w.recency_decay * recencyDecay;
    rows.push({ id, score, channels: f.channels });
  }
  return rows.sort((a, b) => b.score - a.score);
}

/** Budget-гварды (ТЗ §19): обрезка per-item и total. */
export function applyBudget(
  rows: Array<{ item: Item; body: string }>,
  config: EvolveConfig,
): { items: Array<{ item: Item; body: string }>; truncated: boolean } {
  const per = config.retrieval.budget.max_chars_per_item;
  const total = config.retrieval.budget.max_total_recall_chars;
  let truncated = false;
  let used = 0;
  const items: Array<{ item: Item; body: string }> = [];
  for (const row of rows) {
    let body = row.body;
    if (per > 0 && body.length > per) {
      body = `${body.slice(0, per)}…`;
      truncated = true;
    }
    if (total > 0) {
      if (used + body.length > total) {
        const room = total - used - 1; // минус 1 на «…»
        if (room > 40) {
          body = `${body.slice(0, room)}…`;
          truncated = true;
          items.push({ item: row.item, body });
        }
        truncated = true;
        break; // остальное не влезает
      }
      used += body.length;
    }
    items.push({ item: row.item, body });
  }
  return { items, truncated };
}

/** Загружает retrievable-элементы (активные+canary, по agent) — для ранка и ответа. */
async function loadItems(pool: Pool, agentId: string): Promise<Map<string, ItemRow>> {
  const res = await pool.query(
    `SELECT id, type, title, scope, tags, body, version, score_global AS score, created_at
     FROM items WHERE status IN ('active', 'canary') AND (applies_to = 'all' OR applies_to = $1)`,
    [agentId],
  );
  return new Map(res.rows.map((r) => [r["id"], r as ItemRow]));
}

export function itemFromRow(row: ItemRow): Item {
  return {
    id: row.id,
    // type — из БД: нужен для ablation.negative-фильтра (ТЗ §12.4, harness.md §6)
    type: (row.type ?? "fact") as Item["type"],
    title: row.title,
    scope: row.scope,
    tags: [...row.tags],
    appliesTo: "all",
    status: "active", // в этом канале только active/canary
    riskTier: "low",
    version: row.version,
    body: row.body,
    bodyHash: "",
    embeddingId: null,
    scoreGlobal: row.score,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.created_at.toISOString(),
  };
}

export async function retrieve(
  pool: Pool,
  req: RetrieveRequest,
  config: EvolveConfig,
  llm: LlmClient,
  now: Date = new Date(),
): Promise<RetrieveResult> {
  const started = Date.now();
  const topK = config.retrieval.top_k;
  const timeout = config.retrieval.budget.timeout_ms;

  const work = (async (): Promise<Array<{ item: Item; body: string; channels: string[]; finalScore: number }>> => {
    await indexMissingEmbeddings(pool, llm);
    const channels: Record<string, string[]> = {};
    if (config.retrieval.mode === "hybrid" || config.retrieval.mode === "keyword") {
      channels["keyword"] = await keywordSearch(pool, req.query, req.agentId, topK * 2);
    }
    if (config.retrieval.mode === "hybrid" || config.retrieval.mode === "embedding") {
      channels["vector"] = await vectorSearch(pool, llm.embed(req.query), req.agentId, topK * 2);
    }
    const fused = rrfFuse(channels, config.retrieval.rrf_k);
    const items = await loadItems(pool, req.agentId);
    // Relevance-cutoff (Op.2): nearest-neighbor без порога всегда что-то
    // отдаёт — элементы с finalRank ниже min_final_score не в выдачу (0 = off).
    const ranked = finalRank(fused, items, config, req.scopeHints ?? [], now)
      .filter((r) => r.score >= config.retrieval.min_final_score)
      .slice(0, topK);
    return ranked
      .map((r) => {
        const row = items.get(r.id);
        if (!row) {
          return null;
        }
        const item = itemFromRow(row);
        item.status = "canary"; // статус не важен для потребителя; канал отфильтровал
        item.scoreGlobal = row.score;
        return { item, body: item.body, channels: r.channels, finalScore: r.score };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  })();

  let outcome: Awaited<typeof work> | null = null;
  let timedOut = false;
  try {
    outcome = await Promise.race([
      work,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout).unref()),
    ]);
  } catch (err) {
    // Ошибка канала не блокирует задачу (ТЗ §19): деградация → пустой ответ.
    console.error(`[evolve] retrieval error: ${err instanceof Error ? err.message : String(err)}`);
    outcome = null;
  }
  if (outcome === null) {
    timedOut = true;
    return { items: [], truncated: false, tookMs: Date.now() - started, timedOut };
  }

  const budgeted = applyBudget(
    outcome.map((r) => ({ item: r.item, body: r.body })),
    config,
  );
  // Ablation (ТЗ §12.4, harness.md §6): negative-модуль off → negative не в выдаче.
  // Индексы outcome сохраняются (filter по исходным позициям).
  const finalItems = budgeted.items
    .map((r, i) => ({ r, i }))
    .filter((x) => config.ablation.negative !== false || x.r.item.type !== "negative");
  // usage_log: знание было доступно ДО задачи (ТЗ §10.3) — только если task_id;
  // пишется для фактически инжектируемых элементов (после ablation-фильтра).
  if (req.taskId && finalItems.length > 0) {
    for (const { r } of finalItems) {
      await pool.query(
        `INSERT INTO usage_log (item_id, version, agent_id, task_id, task_success, retrieved_at)
         VALUES ($1,$2,$3,$4,NULL, now())`,
        [r.item.id, r.item.version, req.agentId, req.taskId],
      );
    }
  }
  return {
    items: finalItems.map(({ r, i }) => ({
      item: r.item,
      body: r.body,
      channels: outcome[i]?.channels ?? [],
      finalScore: outcome[i]?.finalScore ?? 0,
    })),
    truncated: budgeted.truncated,
    tookMs: Date.now() - started,
    timedOut,
  };
}
