import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { MockLlm } from "../src/llm/client.js";
import { retrieve } from "../src/retrieval/search.js";
import { formatResponse } from "../src/service/retrieve.js";
import { hashBody } from "../src/domain/hashing.js";

const CONFIG = loadConfig(new URL("../config.yaml", import.meta.url).pathname);
const NOW = new Date("2026-09-14T12:00:00Z");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const INJECT_DB_URL = process.env["EVOLVE_INJECT_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_inject_test";
const CUT_DB_URL = process.env["EVOLVE_INJECT_CUT_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_inject_cut_test";

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
    const dir = path.join(ROOT, "db", "migrations");
    const client = await pool.connect();
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
        await client.query("BEGIN");
        await client.query(readFileSync(path.join(dir, f), "utf8"));
        await client.query("COMMIT");
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function seedActive(pool: Pool, title: string, body: string, appliesTo = "all"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO items (id, type, title, scope, tags, applies_to, status, risk_tier, version, body, body_hash, score_global, created_at, updated_at)
     VALUES ($1, 'heuristic', $2, 'all', '{adapter}', $3, 'active', 'low', 1, $4, 'sha256:t', 0.5, now() - interval '2 days', now())`,
    [id, title, appliesTo, body],
  );
  return id;
}

describe.skipIf(!pgAvailable)("адаптер агента: inject (Op.1)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await freshDb(INJECT_DB_URL, "evolve_inject_test");
    pool = new Pool({ connectionString: INJECT_DB_URL, max: 2 });
    await pool.query(
      `INSERT INTO agent_profiles (agent_id, context_budget, retrieval_top_k, format)
       VALUES ('dsh', 8000, 5, 'json'), ('claude', 8000, 3, 'markdown')
       ON CONFLICT (agent_id) DO NOTHING`,
    );
    await seedActive(pool, "инструкция по адаптеру миграций", "миграции: сначала прогоняй migration-тест, потом меняй схему");
    await seedActive(pool, "урок про кэширование запросов", "запросы к базе кэшируй на 60 секунд, инвалидация по записи");
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  it("markdown-профиль: текстовый блок + top-k из профиля", async () => {
    const result = await retrieve(pool, { query: "миграции схемы тест", agentId: "claude" }, CONFIG, new MockLlm(), NOW);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((r) => r.item.title === "инструкция по адаптеру миграций")).toBe(true);
    const out = formatResponse(result, "markdown", { retrievalTopK: 3, contextBudget: 8000 }) as {
      markdown: string;
    };
    expect(out.markdown).toMatch(/## Знания \(evolve, \d+ из top-k=3\)/);
    expect(out.markdown).toContain("инструкция по адаптеру миграций");
  });

  it("usage_log: знание записано ДО задачи (ТЗ §10.3)", async () => {
    const taskId = `adapter-task-${randomUUID().slice(0, 6)}`;
    const result = await retrieve(
      pool,
      { query: "миграции схемы тест", agentId: "dsh", taskId },
      CONFIG,
      new MockLlm(),
      NOW,
    );
    expect(result.items.length).toBeGreaterThan(0);
    const rows = await pool.query(
      `SELECT count(*)::int AS n,
              count(DISTINCT agent_id)::int AS agents,
              min(agent_id) AS agent,
              count(*) FILTER (WHERE task_success IS NOT NULL)::int AS with_verdict
       FROM usage_log u WHERE u.task_id = $1`,
      [taskId],
    );
    expect(Number(rows.rows[0]["n"])).toBe(result.items.length);
    expect(Number(rows.rows[0]["agents"])).toBe(1);
    expect(rows.rows[0]["agent"]).toBe("dsh");
    expect(Number(rows.rows[0]["with_verdict"])).toBe(0); // вердикт придёт позже (task verify)
  });

  it("tool_call-формат: envelope knowledge (для tool-слоя агента)", async () => {
    const result = await retrieve(pool, { query: "кэширование запросов", agentId: "dsh" }, CONFIG, new MockLlm(), NOW);
    const out = formatResponse(result, "tool_call", null) as { tool: string; arguments: { items: unknown[] } };
    expect(out.tool).toBe("knowledge");
    expect(out.arguments.items.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!pgAvailable)("relevance-cutoff (Op.2): retrieval.min_final_score", () => {
  let pool: Pool;

  beforeAll(async () => {
    await freshDb(CUT_DB_URL, "evolve_inject_cut_test");
    pool = new Pool({ connectionString: CUT_DB_URL, max: 2 });
    await seedActive(pool, "инструкция по адаптеру миграций", "миграции: сначала прогоняй migration-тест, потом меняй схему");
    await seedActive(pool, "урок про кэширование запросов", "запросы к базе кэшируй на 60 секунд, инвалидация по записи");
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  it("дефолт 0 = off: nearest-neighbor возвращает (созвучный запрос)", async () => {
    const res = await retrieve(
      pool,
      { query: "миграции схемы тест", agentId: "dsh" },
      CONFIG,
      new MockLlm(),
      NOW,
    );
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.some((r) => r.item.title === "инструкция по адаптеру миграций")).toBe(true);
  });

  it("cutoff: хвост выдачи подрезается, а недостижимый порог — пустота", async () => {
    const base = await retrieve(
      pool,
      { query: "миграции схемы тест", agentId: "dsh" },
      CONFIG,
      new MockLlm(),
      NOW,
    );
    expect(base.items.length).toBeGreaterThanOrEqual(1);
    const minScore = Math.min(...base.items.map((r) => r.finalScore));
    const cut = await retrieve(
      pool,
      { query: "миграции схемы тест", agentId: "dsh" },
      { ...CONFIG, retrieval: { ...CONFIG.retrieval, min_final_score: minScore + 0.001 } },
      new MockLlm(),
      NOW,
    );
    expect(cut.items.length).toBe(base.items.length - 1); // ровно самый слабый элемент подрезан

    const none = await retrieve(
      pool,
      { query: "миграции схемы тест", agentId: "dsh", taskId: "cut-empty-task" },
      { ...CONFIG, retrieval: { ...CONFIG.retrieval, min_final_score: 10 } },
      new MockLlm(),
      NOW,
    );
    expect(none.items).toHaveLength(0);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM usage_log WHERE task_id = 'cut-empty-task'`);
    expect(Number(rows.rows[0]["n"])).toBe(0); // пусто → usage не пишется
  });
});

// CLI-обвязка: только если dist собран (npm run build до тестов)
const cliPath = path.join(ROOT, "dist", "cli.js");

describe.skipIf(!pgAvailable || !existsSync(cliPath))("адаптер: CLI inject knowledge (Op.1)", () => {
  it("markdown-профиль печатает текст (не JSON)", async () => {
    const { stdout } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      execFile(
        "node",
        [
          cliPath,
          "inject",
          "knowledge",
          "--db",
          INJECT_DB_URL,
          "--agent",
          "claude",
          "--query",
          "миграции схемы тест",
        ],
        (err, stdout, stderr) => resolve({ stdout, stderr, code: err ? 1 : 0 }),
      );
    });
    expect(stdout).toMatch(/## Знания \(evolve, \d+ из top-k=3\)/);
  });
});
