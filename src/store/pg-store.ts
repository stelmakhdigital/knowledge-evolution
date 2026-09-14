import { Pool, type QueryResultRow } from "pg";
import { telemetryEventSchema, TelemetryError, type TelemetryEvent } from "../domain/telemetry.js";
import { hashBody } from "../domain/hashing.js";
import { InvariantViolationError, NotFoundError } from "../domain/errors.js";
import { checkTransition } from "../domain/state-machine.js";
import type {
  AgentProfile,
  Clock,
  Contradiction,
  Decision,
  GateName,
  GateResult,
  Item,
  ItemVersion,
  Provenance,
  UsageLogEntry,
} from "../domain/types.js";
import type { CreateItemInput, TransitionInput } from "./store.js";
import type { AsyncStore } from "./async-store.js";

/**
 * Postgres-хранилище (M2, ТЗ §5/§7.1): источник правды — SQL (схема db/schema.sql
 * + миграции db/migrations/), pgvector — только индекс (таблица embeddings, M2.2).
 * Инварианты зеркалят MemoryStore (ТЗ §7.2): создание только как candidate,
 * archived — только с причиной, версии иммутабельны, каждое изменение — decision.
 * Часть инвариантов дублируется DDL (triggers/CHECK) — защита «на двух уровнях».
 */

export interface PgStoreOptions {
  readonly connectionString: string;
  readonly clock?: Clock;
  readonly max?: number; // пул, default 10
}

const iso = (v: Date | string | null | undefined): string =>
  v == null ? "" : (v instanceof Date ? v.toISOString() : String(v));

export class PgStore implements AsyncStore {
  private readonly pool: Pool;
  private readonly clock: Clock;
  private closed = false;

  constructor(options: PgStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
    this.clock = options.clock ?? (() => new Date());
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pool.end();
  }

  /** Для тестов: живой ли коннект (быстро, без блокировки). */
  async ping(timeoutMs = 1500): Promise<boolean> {
    try {
      await Promise.race([
        this.pool.query("SELECT 1"),
        new Promise((_res, rej) => setTimeout(() => rej(new Error("ping timeout")), timeoutMs).unref()),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  // --- items ---

  async addItem(input: CreateItemInput): Promise<void> {
    const { item, provenance, initialDecision } = input;
    if (item.status !== "candidate") {
      throw new InvariantViolationError(
        "INVALID_ITEM_CREATION",
        `item обязан создаваться со status='candidate' (ТЗ §8), передано '${item.status}'`,
      );
    }
    if (item.bodyHash !== hashBody(item.body)) {
      throw new InvariantViolationError("BODY_HASH_MISMATCH", `body_hash не соответствует body у item ${item.id}`);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO items (id, type, title, scope, tags, applies_to, status, risk_tier, version, body, body_hash, embedding_id, score_global, created_at, updated_at, archived_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          item.id, item.type, item.title, item.scope, [...item.tags], item.appliesTo, item.status,
          item.riskTier, item.version, item.body, item.bodyHash, item.embeddingId ?? null,
          item.scoreGlobal, item.createdAt, item.updatedAt, item.archivedReason ?? null,
        ],
      );
      await client.query(
        `INSERT INTO item_versions (item_id, version, body, body_hash, embedding_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [item.id, item.version, item.body, item.bodyHash, item.embeddingId ?? null, item.createdAt],
      );
      for (const pr of provenance) {
        await client.query(
          `INSERT INTO provenance (item_id, version, source_type, task_id, transcript_hash, commit, payload, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [item.id, item.version, pr.sourceType, pr.taskId, pr.transcriptHash, pr.commit, pr.payload, pr.createdAt],
        );
      }
      await client.query(
        `INSERT INTO decisions (item_id, version, kind, actor, reason, evidence, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [item.id, item.version, initialDecision.kind, initialDecision.actor, initialDecision.reason, initialDecision.evidence, this.now()],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof Error && err.message.includes("duplicate key")) {
        throw new InvariantViolationError("DUPLICATE_ITEM", `item ${item.id} уже существует`);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getItem(id: string): Promise<Item | null> {
    const res = await this.pool.query(`SELECT * FROM items WHERE id = $1`, [id]);
    return res.rows.length === 0 ? null : itemFromRow(res.rows[0]);
  }

  async listItems(filter?: { status?: string; type?: string }): Promise<readonly Item[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter?.type) {
      params.push(filter.type);
      where.push(`type = $${params.length}`);
    }
    const sql = `SELECT * FROM items ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at, id`;
    const res = await this.pool.query(sql, params);
    return res.rows.map(itemFromRow);
  }

  async applyTransition(itemId: string, input: TransitionInput): Promise<Item> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [itemId]);
      if (locked.rows.length === 0) {
        throw new NotFoundError(`item ${itemId} не найден`);
      }
      const item = itemFromRow(locked.rows[0]);
      if (input.to === "archived" && (!input.archivedReason || input.archivedReason.length === 0)) {
        throw new InvariantViolationError(
          "ARCHIVE_REASON_REQUIRED",
          `переход в archived требует archived_reason (ТЗ §7.2.1)`,
        );
      }
      checkTransition({ from: item.status, to: input.to, kind: input.kind, actor: input.actor }); // InvalidTransitionError
      await client.query(
        `INSERT INTO decisions (item_id, version, kind, actor, reason, evidence, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [itemId, item.version, input.kind, input.actor, input.reason, input.evidence ?? {}, this.now()],
      );
      // archived_reason immutable (DDL-триггер дополнительно страхует).
      const archivedReason =
        input.to === "archived" ? (input.archivedReason as string) : item.archivedReason ?? null;
      const updated = await client.query(
        `UPDATE items SET status = $1, archived_reason = $2, updated_at = $3 WHERE id = $4 RETURNING *`,
        [input.to, archivedReason, this.now(), itemId],
      );
      await client.query("COMMIT");
      return itemFromRow(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // --- версии ---

  async addVersion(itemId: string, body: string, decision: Omit<Decision, "id" | "itemId" | "version" | "createdAt">): Promise<Item> {
    if (decision.kind !== "approve_edit") {
      throw new InvariantViolationError(
        "INVALID_DECISION_KIND",
        "новая версия тела требует kind='approve_edit' (ТЗ §12.1 «принять с правкой»)",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [itemId]);
      if (locked.rows.length === 0) {
        throw new NotFoundError(`item ${itemId} не найден`);
      }
      const item = itemFromRow(locked.rows[0]);
      const nextVersion = item.version + 1;
      const bodyHash = hashBody(body);
      const now = this.now();
      const ins = await client.query(
        `INSERT INTO item_versions (item_id, version, body, body_hash, created_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [itemId, nextVersion, body, bodyHash, now],
      );
      const newVersionId: string = ins.rows[0]["id"];
      // Старая версия остаётся searchable, связь superseded_by — новая (ТЗ §7.2.2/§7.2.5).
      await client.query(
        `UPDATE item_versions SET superseded_by = $1 WHERE item_id = $2 AND version = $3 AND superseded_by IS NULL`,
        [newVersionId, itemId, item.version],
      );
      await client.query(
        `INSERT INTO decisions (item_id, version, kind, actor, reason, evidence, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [itemId, nextVersion, "approve_edit", decision.actor, decision.reason, decision.evidence, now],
      );
      const updated = await client.query(
        `UPDATE items SET version = $1, body = $2, body_hash = $3, updated_at = $4 WHERE id = $5 RETURNING *`,
        [nextVersion, body, bodyHash, now, itemId],
      );
      await client.query("COMMIT");
      return itemFromRow(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async itemVersions(itemId: string): Promise<readonly ItemVersion[]> {
    const res = await this.pool.query(
      `SELECT * FROM item_versions WHERE item_id = $1 ORDER BY version`,
      [itemId],
    );
    return res.rows.map((r) => versionFromRow(r));
  }

  // --- провенанс ---

  async provenanceFor(itemId: string): Promise<readonly Provenance[]> {
    const res = await this.pool.query(
      `SELECT * FROM provenance WHERE item_id = $1 ORDER BY created_at`,
      [itemId],
    );
    return res.rows.map((r) => ({
      sourceType: r["source_type"],
      taskId: r["task_id"],
      transcriptHash: r["transcript_hash"],
      commit: r["commit"],
      payload: r["payload"] as Record<string, unknown>,
      createdAt: iso(r["created_at"]),
    }));
  }

  // --- гейты ---

  async addGateResult(gateResult: GateResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO gate_results (candidate_id, gate, result, detail, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [gateResult.candidateId, gateResult.gate, gateResult.outcome, gateResult.detail, gateResult.createdAt],
    );
  }

  async gateResultsFor(candidateId: string): Promise<readonly GateResult[]> {
    const res = await this.pool.query(
      `SELECT * FROM gate_results WHERE candidate_id = $1 ORDER BY created_at`,
      [candidateId],
    );
    return res.rows.map(gateResultFromRow);
  }

  async listGateResults(filter?: { gate?: GateName; since?: string; agentId?: string }): Promise<readonly GateResult[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.gate) {
      params.push(filter.gate);
      where.push(`gate = $${params.length}`);
    }
    if (filter?.since) {
      params.push(filter.since);
      where.push(`created_at >= $${params.length}`);
    }
    if (filter?.agentId) {
      params.push(filter.agentId);
      where.push(`detail->>'agent_id' = $${params.length}`);
    }
    const sql = `SELECT * FROM gate_results ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at`;
    const res = await this.pool.query(sql, params);
    return res.rows.map(gateResultFromRow);
  }

  // --- решения ---

  async decisionsFor(itemId: string): Promise<readonly Decision[]> {
    const res = await this.pool.query(
      `SELECT * FROM decisions WHERE item_id = $1 ORDER BY created_at`,
      [itemId],
    );
    return res.rows.map((r) => ({
      id: r["id"],
      itemId: r["item_id"],
      version: r["version"],
      kind: r["kind"],
      actor: r["actor"],
      reason: r["reason"],
      evidence: (r["evidence"] ?? {}) as Record<string, unknown>,
      createdAt: iso(r["created_at"]),
    }));
  }

  // --- телеметрия ---

  async addUsage(entry: UsageLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_log (item_id, version, agent_id, task_id, task_success, retrieved_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.itemId, entry.version, entry.agentId, entry.taskId, entry.taskSuccess, entry.retrievedAt],
    );
  }

  async usageFor(itemId: string): Promise<readonly UsageLogEntry[]> {
    const res = await this.pool.query(
      `SELECT * FROM usage_log WHERE item_id = $1 ORDER BY retrieved_at`,
      [itemId],
    );
    return res.rows.map(usageFromRow);
  }

  async usageForTask(taskId: string): Promise<readonly UsageLogEntry[]> {
    const res = await this.pool.query(
      `SELECT * FROM usage_log WHERE task_id = $1 ORDER BY retrieved_at`,
      [taskId],
    );
    return res.rows.map(usageFromRow);
  }

  async addEvent(event: TelemetryEvent): Promise<void> {
    const validated = telemetryEventSchema.parse(event); // неизвестное/битое — не в базу
    // agent_id есть не у всех типов событий (review_recorded) — колонка nullable.
    const ev = validated as { event: string; task_id: string; agent_id?: string };
    await this.pool.query(
      `INSERT INTO events (event_type, task_id, agent_id, payload, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [ev.event, ev.task_id, ev.agent_id ?? null, validated as unknown, this.now()],
    );
  }

  async listEvents(filter?: { taskId?: string }): Promise<readonly TelemetryEvent[]> {
    const params: unknown[] = [];
    let where = "";
    if (filter?.taskId) {
      params.push(filter.taskId);
      where = `WHERE task_id = $1`;
    }
    const res = await this.pool.query(`SELECT * FROM events ${where} ORDER BY created_at`, params);
    return res.rows.map((r) => telemetryEventSchema.parse(r["payload"] as unknown));
  }

  async backfillUsageForTask(taskId: string, success: boolean): Promise<{ updated: number; unchanged: number }> {
    const existing = await this.pool.query(
      `SELECT id, task_success FROM usage_log WHERE task_id = $1`,
      [taskId],
    );
    let conflict = false;
    for (const row of existing.rows) {
      const cur = row["task_success"] as boolean | null;
      if (cur !== null && cur !== success) {
        conflict = true;
        break;
      }
    }
    if (conflict) {
      throw new TelemetryError(
        "TELEMETRY_CONFLICT",
        `задача ${taskId}: в usage_log уже есть вердикт, противоречащий ${success} (ТЗ §10.3)`,
      );
    }
    const updated = await this.pool.query(
      `UPDATE usage_log SET task_success = $2 WHERE task_id = $1 AND task_success IS NULL`,
      [taskId, success],
    );
    const unchanged = existing.rows.filter((r) => r["task_success"] === success).length;
    return { updated: updated.rowCount ?? 0, unchanged };
  }

  // --- противоречия ---

  async addContradiction(c: Contradiction): Promise<void> {
    await this.pool.query(
      `INSERT INTO contradictions (id, item_a_id, item_b_id, severity, status, resolved_by, created_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        c.id, c.itemAId, c.itemBId, c.severity, c.status,
        c.resolvedBy ?? null, c.createdAt, c.resolvedAt ?? null,
      ],
    );
  }

  async listContradictions(filter?: { status?: "open" | "resolved" }): Promise<readonly Contradiction[]> {
    const params: unknown[] = [];
    let where = "";
    if (filter?.status) {
      params.push(filter.status);
      where = `WHERE status = $1`;
    }
    const res = await this.pool.query(`SELECT * FROM contradictions ${where} ORDER BY created_at`, params);
    return res.rows.map((r) => {
      const base: Contradiction = {
        id: r["id"],
        itemAId: r["item_a_id"],
        itemBId: r["item_b_id"],
        severity: r["severity"] as Contradiction["severity"],
        status: r["status"] as Contradiction["status"],
        resolvedBy: (r["resolved_by"] ?? null) as string | null,
        createdAt: iso(r["created_at"]),
      };
      return r["resolved_at"] ? { ...base, resolvedAt: iso(r["resolved_at"]) } : base;
    });
  }

  async resolveContradiction(id: string, resolvedBy: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE contradictions SET status = 'resolved', resolved_by = $2, resolved_at = $3
       WHERE id = $1 AND status = 'open' RETURNING id`,
      [id, resolvedBy, this.now()],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new NotFoundError(`contradiction ${id} не найдена или уже решена`);
    }
  }

  // --- профили агентов ---

  async getAgentProfile(agentId: string): Promise<AgentProfile | null> {
    const res = await this.pool.query(`SELECT * FROM agent_profiles WHERE agent_id = $1`, [agentId]);
    if (res.rows.length === 0) {
      return null;
    }
    const r = res.rows[0];
    return {
      agentId: r["agent_id"],
      contextBudget: r["context_budget"],
      retrievalTopK: r["retrieval_top_k"],
      format: r["format"],
      createdAt: iso(r["created_at"]),
    };
  }

  async upsertAgentProfile(profile: AgentProfile): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_profiles (agent_id, context_budget, retrieval_top_k, format, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id) DO UPDATE
         SET context_budget = EXCLUDED.context_budget,
             retrieval_top_k = EXCLUDED.retrieval_top_k,
             format = EXCLUDED.format`,
      [profile.agentId, profile.contextBudget, profile.retrievalTopK, profile.format, profile.createdAt],
    );
  }
}

// --- маппинг строк → доменные типы ---

function itemFromRow(r: QueryResultRow): Item {
  const archivedReason = r["archived_reason"] as string | null;
  return {
    id: r["id"],
    type: r["type"],
    title: r["title"],
    scope: r["scope"],
    tags: [...(r["tags"] as string[])],
    appliesTo: r["applies_to"],
    status: r["status"],
    riskTier: r["risk_tier"],
    version: r["version"],
    body: r["body"],
    bodyHash: r["body_hash"],
    embeddingId: (r["embedding_id"] ?? null) as string | null,
    scoreGlobal: r["score_global"],
    createdAt: iso(r["created_at"]),
    updatedAt: iso(r["updated_at"]),
    ...(archivedReason ? { archivedReason } : {}),
  };
}

function versionFromRow(r: QueryResultRow): ItemVersion {
  return {
    id: r["id"],
    itemId: r["item_id"],
    version: r["version"],
    body: r["body"],
    bodyHash: r["body_hash"],
    embeddingId: (r["embedding_id"] ?? null) as string | null,
    createdAt: iso(r["created_at"]),
    supersededBy: (r["superseded_by"] ?? null) as string | null,
  };
}

function gateResultFromRow(r: QueryResultRow): GateResult {
  return {
    id: r["id"],
    candidateId: r["candidate_id"],
    gate: r["gate"],
    outcome: r["result"],
    detail: (r["detail"] ?? {}) as Record<string, unknown>,
    createdAt: iso(r["created_at"]),
  };
}

function usageFromRow(r: QueryResultRow): UsageLogEntry {
  return {
    id: r["id"],
    itemId: r["item_id"],
    version: r["version"],
    agentId: r["agent_id"],
    taskId: r["task_id"],
    taskSuccess: (r["task_success"] ?? null) as boolean | null,
    retrievedAt: iso(r["retrieved_at"]),
  };
}
