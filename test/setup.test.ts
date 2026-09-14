import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const SETUP_DB_URL = process.env["EVOLVE_SETUP_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_setup_test";

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

describe.skipIf(!pgAvailable)("scripts/setup.sh (идемпотентный бутстрап)", () => {
  let skillsDir: string;

  function setup(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile("bash", [path.join(ROOT, "scripts", "setup.sh"), ...args], { env: { ...process.env, PSQL: process.env["PSQL"] ?? `${process.env["HOME"]}/.pgsql/bin/psql` } }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  it("создаёт БД/миграции/профиль/скилл и идемпотентен", async () => {
    skillsDir = mkdtempSync(path.join(tmpdir(), "evolve-skills-"));
    await setup(["--db", SETUP_DB_URL, "--agent", "dsh", "--format", "json", "--skills-dir", skillsDir]);
    await setup(["--db", SETUP_DB_URL, "--agent", "dsh", "--format", "json", "--skills-dir", skillsDir]); // 2-й прогон

    const pool = new Pool({ connectionString: SETUP_DB_URL, max: 2 });
    try {
      const ext = await pool.query(`SELECT count(*)::int AS n FROM pg_extension WHERE extname IN ('vector','pg_trgm')`);
      expect(Number(ext.rows[0]["n"])).toBe(2);
      const mig = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`);
      expect(Number(mig.rows[0]["n"])).toBeGreaterThanOrEqual(5);
      const prof = await pool.query(`SELECT format, retrieval_top_k FROM agent_profiles WHERE agent_id = 'dsh'`);
      expect(prof.rows).toHaveLength(1);
      expect(prof.rows[0]["format"]).toBe("json");
    } finally {
      await pool.end();
    }

    const skill = readFileSync(path.join(skillsDir, "evolve", "SKILL.md"), "utf8");
    expect(skill).toContain("name: evolve");
    expect(skill).toContain(SETUP_DB_URL);
    expect(skill).toContain(ROOT);
    expect(skill).not.toContain("{{REPO}}");
  });
});
