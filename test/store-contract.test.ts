import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { hashBody } from "../src/domain/hashing.js";
import { InvalidTransitionError } from "../src/domain/errors.js";
import { TelemetryError } from "../src/domain/telemetry.js";
import type { Item } from "../src/domain/types.js";
import { asyncStoreOf, type AsyncStore } from "../src/store/async-store.js";
import { MemoryStore } from "../src/store/memory-store.js";
import { PgStore } from "../src/store/pg-store.js";

const NOW = () => new Date("2026-09-14T12:00:00Z");

function makeCandidateItem(id: string, overrides: Partial<Item> = {}): Item {
  const body = `тело элемента ${id}`;
  return {
    id,
    type: "fact",
    title: `элемент ${id}`,
    scope: "src/**",
    tags: ["db"],
    appliesTo: "all",
    status: "candidate",
    riskTier: "low",
    version: 1,
    body,
    bodyHash: hashBody(body),
    embeddingId: null,
    scoreGlobal: 0,
    createdAt: "2026-09-14T12:00:00Z",
    updatedAt: "2026-09-14T12:00:00Z",
    ...overrides,
  };
}

/**
 * Контракт-тесты хранилища (ТЗ §7.2): одни и те же инварианты для MemoryStore
 * (M0) и PgStore (M2). На PG — отдельная БД evolve_test, миграции применяются
 * автоматически (то же, что `evolve migrate`).
 */
function contractSuite(title: string, make: () => Promise<AsyncStore>): void {
  let store: AsyncStore;

  beforeAll(async () => {
    store = await make();
  });
  afterAll(async () => {
    if (store instanceof PgStore) {
      await store.close();
    }
  });

  describe(title, () => {
    it("создание: только как candidate, с верным body_hash (ТЗ §8, §7.2)", async () => {
      const id = randomUUID();
      await store.addItem({
        item: makeCandidateItem(id),
        provenance: [
          {
            sourceType: "success",
            taskId: "t1",
            transcriptHash: "sha256:x",
            commit: "abc",
            payload: { verifier: "tests" },
            createdAt: "2026-09-14T12:00:00Z",
          },
        ],
        initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "low", evidence: {} },
      });
      expect((await store.getItem(id))?.status).toBe("candidate");

      const badStatus = makeCandidateItem(randomUUID(), { status: "active" });
      await expect(
        store.addItem({ item: badStatus, provenance: [], initialDecision: { itemId: badStatus.id, version: 1, kind: "promote", actor: "human", reason: "x", evidence: {} } }),
      ).rejects.toThrow(/INVALID_ITEM_CREATION|candidate/);

      const badHash = makeCandidateItem(randomUUID(), { bodyHash: "sha256:wrong" });
      await expect(
        store.addItem({ item: badHash, provenance: [], initialDecision: { itemId: badHash.id, version: 1, kind: "promote", actor: "human", reason: "x", evidence: {} } }),
      ).rejects.toThrow(/BODY_HASH|body_hash/);
    });

    it("переходы: стейт-машина + аудит в decisions на каждый переход (ТЗ §7.2.3)", async () => {
      const id = randomUUID();
      await store.addItem({
        item: makeCandidateItem(id),
        provenance: [],
        initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "low", evidence: {} },
      });
      await store.applyTransition(id, { to: "queued", kind: "promote", actor: "auto:gate", reason: "high" });
      await store.applyTransition(id, { to: "canary", kind: "promote", actor: "human", reason: "окно" });
      await store.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "ok" });
      expect((await store.getItem(id))?.status).toBe("active");

      const decisions = await store.decisionsFor(id);
      expect(decisions.length).toBe(4); // создание + 3 перехода
      expect(decisions.map((d) => d.actor)).toEqual(["auto:gate", "auto:gate", "human", "auto:canary"]);

      const id2 = randomUUID();
      await store.addItem({
        item: makeCandidateItem(id2),
        provenance: [],
        initialDecision: { itemId: id2, version: 1, kind: "promote", actor: "auto:gate", reason: "low", evidence: {} },
      });
      await expect(
        store.applyTransition(id2, { to: "active", kind: "promote", actor: "human", reason: "проскочить" }),
      ).rejects.toThrow(InvalidTransitionError);
    });

    it("archived — только с причиной (ТЗ §7.2.1)", async () => {
      const id = randomUUID();
      await store.addItem({
        item: makeCandidateItem(id),
        provenance: [],
        initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "low", evidence: {} },
      });
      // candidate → archived: kind='reject' (стейт-машина: гейт не пройден / отклонён)
      await expect(
        store.applyTransition(id, { to: "archived", kind: "reject", actor: "human", reason: "без причины" }),
      ).rejects.toThrow(/ARCHIVE_REASON|archived_reason/);
      const updated = await store.applyTransition(id, {
        to: "archived",
        kind: "reject",
        actor: "human",
        reason: "устарело",
        archivedReason: "устарело",
      });
      expect(updated.status).toBe("archived");
      expect(updated.archivedReason).toBe("устарело");
    });

    it("версии: только approve_edit, иммутабельная история, superseded_by (ТЗ §7.2.2)", async () => {
      const id = randomUUID();
      await store.addItem({
        item: makeCandidateItem(id),
        provenance: [],
        initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "low", evidence: {} },
      });
      await expect(
        store.addVersion(id, "новое тело с другой причиной", { kind: "promote", actor: "human", reason: "x", evidence: {} }),
      ).rejects.toThrow(/INVALID_DECISION_KIND|approve_edit/);
      const updated = await store.addVersion(id, "новое тело после правки", {
        kind: "approve_edit",
        actor: "human",
        reason: "сужили scope",
        evidence: { source: "queue" },
      });
      expect(updated.version).toBe(2);
      expect(updated.body).toBe("новое тело после правки");
      const versions = await store.itemVersions(id);
      expect(versions).toHaveLength(2);
      expect(versions[0]?.version).toBe(1);
      expect(versions[0]?.body).toBe(`тело элемента ${id}`); // старое тело не меняется
      expect(versions[0]?.supersededBy).toBe(versions[1]?.id);
      const decisions = await store.decisionsFor(id);
      expect(decisions.at(-1)?.kind).toBe("approve_edit");
    });

    it("провенанс сохраняется и читается (white-box, ТЗ §7.2.7)", async () => {
      const id = randomUUID();
      await store.addItem({
        item: makeCandidateItem(id),
        provenance: [
          {
            sourceType: "review",
            taskId: "task-prov",
            transcriptHash: "sha256:prov",
            commit: "commit-prov",
            payload: { verifier: "human", rating: 4 },
            createdAt: "2026-09-14T12:00:00Z",
          },
        ],
        initialDecision: { itemId: id, version: 1, kind: "promote", actor: "human", reason: "low", evidence: {} },
      });
      const prov = await store.provenanceFor(id);
      expect(prov).toHaveLength(1);
      expect(prov[0]?.taskId).toBe("task-prov");
      expect(prov[0]?.commit).toBe("commit-prov");
      expect(prov[0]?.payload["rating"]).toBe(4);
    });

    it("гейты: add/list + фильтр по agent_id из detail (G5)", async () => {
      const c1 = `cand-${randomUUID()}`;
      await store.addGateResult({
        id: randomUUID(),
        candidateId: c1,
        gate: "budget",
        outcome: "fail",
        detail: { agent_id: "dsh", limit: 5 },
        createdAt: "2026-09-14T12:00:00Z",
      });
      await store.addGateResult({
        id: randomUUID(),
        candidateId: c1,
        gate: "evidence",
        outcome: "pass",
        detail: { agent_id: "dsh" },
        createdAt: "2026-09-14T12:00:00Z",
      });
      expect((await store.gateResultsFor(c1)).length).toBe(2);
      const byAgent = await store.listGateResults({ gate: "budget", agentId: "dsh" });
      expect(byAgent).toHaveLength(1);
      expect(byAgent[0]?.candidateId).toBe(c1);
    });

    it("usage_log + backfill по task_verified: первый вердикт приоритет, конфликт — ошибка (ТЗ §10.3)", async () => {
      const id = randomUUID();
      await store.addItem({
        item: makeCandidateItem(id),
        provenance: [],
        initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "low", evidence: {} },
      });
      const taskId = `task-${randomUUID()}`;
      await store.addUsage({
        id: randomUUID(),
        itemId: id,
        version: 1,
        agentId: "dsh",
        taskId,
        taskSuccess: null,
        retrievedAt: "2026-09-14T12:00:00Z",
      });
      await store.addUsage({
        id: randomUUID(),
        itemId: id,
        version: 1,
        agentId: "dsh",
        taskId,
        taskSuccess: null,
        retrievedAt: "2026-09-14T12:00:00Z",
      });
      const r1 = await store.backfillUsageForTask(taskId, true);
      expect(r1.updated).toBe(2);
      const r2 = await store.backfillUsageForTask(taskId, true); // идемпотентно
      expect(r2.updated).toBe(0);
      expect(r2.unchanged).toBe(2);
      await expect(store.backfillUsageForTask(taskId, false)).rejects.toThrow(TelemetryError);
      expect((await store.usageForTask(taskId)).every((u) => u.taskSuccess === true)).toBe(true);
    });

    it("события телеметрии: запись + чтение по task_id", async () => {
      const taskId = `task-${randomUUID()}`;
      await store.addEvent({
        event: "task_started",
        task_id: taskId,
        agent_id: "dsh",
        scope_hints: ["db"],
        started_at: "2026-09-14T12:00:00Z",
      });
      await store.addEvent({
        event: "task_verified",
        task_id: taskId,
        agent_id: "dsh",
        success: true,
        verifier: "tests",
        verifier_id: "vitest",
        verified_at: "2026-09-14T12:05:00Z",
      });
      const events = await store.listEvents({ taskId });
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.event)).toEqual(["task_started", "task_verified"]);
    });

    it("противоречия: add/list/resolve (повторное resolve — ошибка)", async () => {
      const a = randomUUID();
      const b = randomUUID();
      for (const id of [a, b]) {
        await store.addItem({
          item: makeCandidateItem(id),
          provenance: [],
          initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "low", evidence: {} },
        });
      }
      const cid = randomUUID();
      await store.addContradiction({
        id: cid,
        itemAId: a,
        itemBId: b,
        severity: "med",
        status: "open",
        resolvedBy: null,
        createdAt: "2026-09-14T12:00:00Z",
      });
      expect((await store.listContradictions({ status: "open" })).some((c) => c.id === cid)).toBe(true);
      await store.resolveContradiction(cid, "human:anna");
      expect((await store.listContradictions({ status: "resolved" })).some((c) => c.id === cid)).toBe(true);
      await expect(store.resolveContradiction(cid, "human:anna")).rejects.toThrow();
    });

    it("профили агентов: upsert/get (agent-agnostic, ТЗ §14)", async () => {
      const agentId = `agent-${randomUUID()}`;
      expect(await store.getAgentProfile(agentId)).toBeNull();
      await store.upsertAgentProfile({
        agentId,
        contextBudget: 2000,
        retrievalTopK: 5,
        format: "markdown",
        createdAt: "2026-09-14T12:00:00Z",
      });
      let profile = await store.getAgentProfile(agentId);
      expect(profile?.contextBudget).toBe(2000);
      await store.upsertAgentProfile({ ...profile as NonNullable<typeof profile>, contextBudget: 4000 });
      expect((await store.getAgentProfile(agentId))?.contextBudget).toBe(4000);
    });
  });
}

contractSuite("MemoryStore (M0)", async () => asyncStoreOf(new MemoryStore(NOW)));

// --- PG-контракт: отдельная БД evolve_test ---

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const TEST_DB_URL = process.env["EVOLVE_TEST_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_test";

async function makePgStore(): Promise<PgStore> {
  // Свежая БД на каждый прогон: контракт-тесты идемпотентны, мусора между run не остаётся.
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS evolve_test WITH (FORCE)`);
    await admin.query(`CREATE DATABASE evolve_test`);
  } finally {
    await admin.end();
  }
  // Миграции (то же, что `evolve migrate`), но в тестовую БД.
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 2 });
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dir = path.join(root, "db", "migrations");
    const client = await pool.connect();
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const applied = new Set((await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r["name"] as string));
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
        if (applied.has(f)) {
          continue;
        }
        await client.query("BEGIN");
        await client.query(readFileSync(path.join(dir, f), "utf8"));
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
        await client.query("COMMIT");
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  return new PgStore({ connectionString: TEST_DB_URL, clock: NOW });
}

// Проверка живого PG ДО сбора сьютов (top-level await): skipIf оценивается при загрузке файла.
const pgAvailable = await (async (): Promise<boolean> => {
  try {
    // Проверка по admin-БД: тестовая evolve_test ещё может не существовать (создаст makePgStore).
    const pool = new Pool({ connectionString: ADMIN_URL, max: 1 });
    const ok = (await pool.query("SELECT 1")).rows.length === 1;
    await pool.end();
    return ok;
  } catch {
    return false;
  }
})();

describe.skipIf(!pgAvailable)("PgStore (M2, живой Postgres 16 + pgvector)", () => {
  contractSuite("контракт на PG", makePgStore);
});

// Служебное: проверка, что миграции запускаются как CLI (защита от рассинхрона).
describe("evolve migrate (CLI)", () => {
  it("применяет миграции в evolve_test (через dist)", async () => {
    if (!pgAvailable) {
      return; // без PG — пропуск
    }
    const out = execSync(
      `node dist/cli.js migrate --db ${TEST_DB_URL}`,
      { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" },
    );
    expect(out).toMatch(/миграций применено/);
  });
});
