import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

/**
 * Agent-agnostic audit (M5.1, ТЗ §14 — hard requirements):
 *  1. no-hardcoded-agents: конвейерный код (src без cli.ts) не содержит
 *     литералов конкретных агентов — агент = agent_id + профиль (ТЗ §14.1);
 *  2. applies-to-default: DDL items.applies_to DEFAULT 'all' (ТЗ §14.2);
 *  3. retrieval-filters-applies-to: retrieval фильтрует по 'all' | agent_id (ТЗ §14.3);
 *  4. score-per-pair: item_scores PK (item_id, agent_id) — score на паре,
 *     global — агрегат (ТЗ §14.4);
 *  5. agent-profiles: таблица профилей + сервис использует профиль (ТЗ §14.1);
 *  6. applies-to-values (только с БД): все applies_to — 'all' или непустой id.
 * CLI: `evolve audit agent-agnostic [--db]`. Статические проверки не требуют БД.
 */

export interface AuditCheck {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly detail: string;
}

const AGENT_LITERAL = /["'](dsh|claude|gpt|codex|copilot|gemini|llama|qwen)["']/;

/** Папки конвейера: логика системы (CLI с UX-дефолтами и тесты исключены). */
const PIPELINE_DIRS = [
  "domain",
  "gates",
  "retrieval",
  "decay",
  "canary",
  "critic",
  "report",
  "queue",
  "review",
  "extractor",
  "llm",
  "store",
  "telemetry",
  "service",
  "config",
  "audit",
];

function read(root: string, rel: string): string | null {
  const p = path.join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function filesUnder(root: string, relDir: string): string[] {
  const dir = path.join(root, relDir);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true })
    .filter((f) => typeof f === "string" && f.endsWith(".ts"))
    .map((f) => path.join(dir, f as string));
}

export async function auditAgentAgnostic(root: string, pool?: Pool): Promise<AuditCheck[]> {
  const checks: AuditCheck[] = [];

  // 1) нет хардкода агентов в конвейерном коде
  const hits: string[] = [];
  for (const dir of PIPELINE_DIRS) {
    for (const file of filesUnder(root, path.join("src", dir))) {
      const content = readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        if (AGENT_LITERAL.test(line)) {
          hits.push(`${path.relative(root, file)}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }
  checks.push({
    id: "no-hardcoded-agents",
    title: "конвейер без ссылок на конкретных агентов (ТЗ §14.1)",
    ok: hits.length === 0,
    detail:
      hits.length === 0
        ? `проверено ${PIPELINE_DIRS.length} папок src/ — литералов агентов нет (CLI-дефолты — UX, не конвейер)`
        : `найдено: ${hits.slice(0, 5).join("; ")}`,
  });

  // 2) DDL: applies_to DEFAULT 'all'
  const schema = read(root, "db/migrations/001_schema.sql") ?? "";
  checks.push({
    id: "applies-to-default",
    title: "items.applies_to DEFAULT 'all' (ТЗ §14.2)",
    ok: /applies_to\s+text NOT NULL DEFAULT 'all'/.test(schema),
    detail: /applies_to\s+text NOT NULL DEFAULT 'all'/.test(schema)
      ? "DDL: applies_to text NOT NULL DEFAULT 'all'"
      : "в 001_schema.sql не найден DEFAULT 'all' для applies_to",
  });

  // 3) retrieval фильтрует по applies_to
  const search = read(root, "src/retrieval/search.ts") ?? "";
  checks.push({
    id: "retrieval-filters-applies-to",
    title: "retrieval: только 'all' | agent_id (ТЗ §14.3)",
    ok: search.includes("applies_to = 'all' OR applies_to ="),
    detail: search.includes("applies_to = 'all' OR applies_to =")
      ? "фильтр (applies_to = 'all' OR applies_to = $agent) на месте"
      : "в src/retrieval/search.ts не найден фильтр applies_to",
  });

  // 4) score на паре (item, agent)
  const scoresMig = read(root, "db/migrations/003_item_scores.sql") ?? "";
  let scoreDetail = "в 003_item_scores.sql нет PK (item_id, agent_id)";
  let scoreOk = /PRIMARY KEY \(item_id, agent_id\)/.test(scoresMig);
  if (scoreOk && pool) {
    const pk = await pool.query(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indisprimary AND i.indrelid = 'item_scores'::regclass
       ORDER BY a.attnum`,
    );
    const cols = pk.rows.map((r) => r["attname"]);
    scoreOk = cols.includes("item_id") && cols.includes("agent_id");
    scoreDetail = scoreOk
      ? `живая БД: PK item_scores (${cols.join(", ")}) — score на паре, global — агрегат`
      : `живая БД: PK item_scores (${cols.join(", ")}) — не (item_id, agent_id)`;
  } else if (scoreOk) {
    scoreDetail = "миграция: PK (item_id, agent_id); score_global — агрегат (recomputeScores)";
  }
  checks.push({
    id: "score-per-pair",
    title: "score на паре (item, agent), global — агрегат (ТЗ §14.4)",
    ok: scoreOk,
    detail: scoreDetail,
  });

  // 5) профили агентов
  const retrieveSvc = read(root, "src/service/retrieve.ts") ?? "";
  let profilesOk = retrieveSvc.includes("agent_profiles WHERE agent_id = $1");
  let profilesDetail = profilesOk
    ? "статика: сервис /retrieve читает agent_profiles (format/top_k)"
    : "сервис /retrieve не читает agent_profiles";
  if (pool) {
    const has = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_name = 'agent_profiles'`,
    );
    profilesOk = profilesOk && Number(has.rows[0]["n"]) === 1;
    profilesDetail = profilesOk
      ? "agent_profiles в БД + сервис использует профиль (format/top_k)"
      : "нет таблицы agent_profiles или сервис не использует профиль";
  }
  checks.push({
    id: "agent-profiles",
    title: "агент = agent_id + профиль (ТЗ §14.1)",
    ok: profilesOk,
    detail: profilesDetail,
  });

  // 6) значения applies_to в БД
  if (pool) {
    const bad = await pool.query(
      `SELECT count(*)::int AS n FROM items WHERE applies_to IS NULL OR length(trim(applies_to)) = 0`,
    );
    const n = Number(bad.rows[0]["n"]);
    checks.push({
      id: "applies-to-values",
      title: "все applies_to — 'all' или непустой id (ТЗ §14.2)",
      ok: n === 0,
      detail: n === 0 ? "нет пустых/NULL applies_to" : `пустых/NULL applies_to: ${n}`,
    });
  }

  return checks;
}
