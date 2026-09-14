import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { runTransferEval } from "../src/audit/transfer.js";
import { hashBody } from "../src/domain/hashing.js";
import { MockLlm } from "../src/llm/client.js";
import { PgStore } from "../src/store/pg-store.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const TRANSFER_DB_URL = process.env["EVOLVE_TRANSFER_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_transfer_test";

const pgAvailable = await (async (): Promise<boolean> => {
  try {
    const pool = new Pool({ connectionString: ADMIN_URL, max: 1 });
    const ok = (await pool.query("SELECT 1")).rows.length === 1;
    await pool.end();
    return ok;
  } catch {
    return false;
  }
})();

async function freshDb(url: string, dbName: string): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dir = path.join(root, "db", "migrations");
    const client = await pool.connect();
    try {
      const applied = new Set<string>();
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
        if (applied.has(f)) {
          continue;
        }
        await client.query("BEGIN");
        await client.query(readFileSync(path.join(dir, f), "utf8"));
        applied.add(f);
        await client.query("COMMIT");
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

describe.skipIf(!pgAvailable)("transfer-тест на живом PG (ТЗ §14.5, M5.2)", () => {
  let store: PgStore;
  let clockNow: Date;
  const setClock = (d: Date): void => {
    clockNow = d;
  };

  async function seedActive(id: string, title: string, body: string, appliesTo: string): Promise<void> {
    const start = new Date(NOW.getTime() - 3 * 86_400_000);
    setClock(start);
    await store.addItem({
      item: {
        id, type: "fact", title, scope: "all", tags: ["m5"],
        appliesTo, status: "candidate", riskTier: "low", version: 1, body,
        bodyHash: hashBody(body), embeddingId: null, scoreGlobal: 0,
        createdAt: start.toISOString(), updatedAt: start.toISOString(),
      },
      provenance: [
        { sourceType: "human", taskId: `seed-${id.slice(0, 4)}`, transcriptHash: `sha256:${id.slice(0, 4)}`, commit: "seed", payload: {}, createdAt: start.toISOString() },
      ],
      initialDecision: { itemId: id, version: 1, kind: "promote", actor: "auto:gate", reason: "seed", evidence: {} },
    });
    setClock(new Date(start.getTime() + 1000));
    await store.applyTransition(id, { to: "canary", kind: "promote", actor: "auto:gate", reason: "low" });
    setClock(new Date(start.getTime() + 2000));
    await store.applyTransition(id, { to: "active", kind: "promote", actor: "auto:canary", reason: "seed" });
    setClock(NOW);
  }

  beforeAll(async () => {
    await freshDb(TRANSFER_DB_URL, "evolve_transfer_test");
    clockNow = NOW;
    store = new PgStore({ connectionString: TRANSFER_DB_URL, clock: () => new Date(clockNow) });
    // два профиля (hard: harness исполним в профилях ≥ 2 моделей)
    await store.pool.query(
      `INSERT INTO agent_profiles (agent_id, context_budget, retrieval_top_k, format)
       VALUES ('dsh', 8000, 5, 'json'), ('claude', 8000, 5, 'markdown')
       ON CONFLICT (agent_id) DO NOTHING`,
    );
  }, 60_000);
  afterAll(async () => {
    await store.close();
  });

  it("all-элементы переносятся, applies_to=другой агент → transfer:weak", async () => {
    const a1 = randomUUID();
    const a2 = randomUUID();
    const a3 = randomUUID();
    const dshOnly = randomUUID();
    await seedActive(a1, "уникальный первый элемент миграций", "тела первого элемента", "all");
    await seedActive(a2, "уникальный второй элемент кэширования", "тела второго элемента", "all");
    await seedActive(a3, "уникальный третий элемент логирования", "тела третьего элемента", "all");
    await seedActive(dshOnly, "поведенческий урок для dsh-модели", "тела dsh-элемента", "dsh");

    const summary = await runTransferEval(store, CONFIG, new MockLlm(), NOW, "claude");
    expect(summary.total).toBe(4);
    expect(summary.transferred).toBe(3);
    expect(summary.weak).toBe(1);

    const weak = summary.results.find((r) => r.itemId === dshOnly);
    expect(weak?.verdict).toBe("weak_excluded");
    expect(weak?.weakTagged).toBe(true);

    const item = await store.getItem(dshOnly);
    expect(item?.tags).toContain("transfer:weak");
    // active не заблокирован (ТЗ §14.5: «не блокирует active»)
    expect(item?.status).toBe("active");

    // idempotency: повторный прогон — тег не дублируется, выводы те же
    const again = await runTransferEval(store, CONFIG, new MockLlm(), NOW, "claude");
    expect(again.transferred).toBe(3);
    expect(again.weak).toBe(1);
    const item2 = await store.getItem(dshOnly);
    const count = (item2?.tags ?? []).filter((t) => t === "transfer:weak").length;
    expect(count).toBe(1);
  });

  it("отсутствие профиля — ошибка (профиль обязателен)", async () => {
    await expect(runTransferEval(store, CONFIG, new MockLlm(), NOW, "неизвестный-агент")).rejects.toThrow(/не найден/);
  });
});
