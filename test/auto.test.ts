import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_URL = process.env["EVOLVE_ADMIN_URL"] ?? "postgres://arka@127.0.0.1:5432/postgres";
const AUTO_DB_URL = process.env["EVOLVE_AUTO_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve_auto_test";

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

function freshDb(url: string, dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-c", `"$HOME/.pgsql/bin/psql" -p 5432 -h "$HOME/pgsql/sock" postgres -qc "DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)" && "$HOME/.pgsql/bin/psql" -p 5432 -h "$HOME/pgsql/sock" postgres -qc "CREATE DATABASE ${dbName}" && cd ${ROOT} && EVOLVE_DB_URL=${url} node dist/cli.js migrate >/dev/null`], (err) => (err ? reject(err) : resolve()));
  });
}

describe.skipIf(!pgAvailable)("scripts/auto.sh (режим «не трогай»)", () => {
  let autoHome: string;

  function auto(cmd: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        "bash",
        [path.join(ROOT, "scripts", "auto.sh"), cmd],
        { env: { ...process.env, HOME: autoHome, EVOLVE_AUTO_DB: AUTO_DB_URL, EVOLVE_AUTO_REPO: ROOT } },
        (err, stdout) => (err ? reject(new Error(`${cmd}: ${stdout}`)) : resolve({ stdout })),
      );
    });
  }

  beforeAll(async () => {
    autoHome = path.join(tmpdir(), `evolve-auto-${Date.now()}`);
    execFileSyncSafe();
    function execFileSyncSafe(): void {
      // mkdir -p + конфиг
      const { execFileSync } = require("node:child_process");
      execFileSync("bash", ["-c", `mkdir -p "${autoHome}/.evolve"`]);
      execFileSync("bash", ["-c", `printf '%s\\n' "${AUTO_DB_URL}" > "${autoHome}/.evolve/db-url"; printf '%s\\n' "${ROOT}" > "${autoHome}/.evolve/repo"`]);
    }
    await freshDb(AUTO_DB_URL, "evolve_auto_test");
  }, 60_000);

  it("daily: scores/canary/decay выполняются, запись в лог", async () => {
    const { stdout } = await auto("daily");
    expect(stdout).toMatch(/ok: scores recompute/);
    expect(stdout).toMatch(/ok: canary evaluate/);
    expect(stdout).toMatch(/ok: decay run/);
    const log = readFileSync(path.join(autoHome, ".evolve", "auto.log"), "utf8");
    expect(log).toMatch(/ok: decay run/);
  });

  it("weekly: отчёт пишется в ~/.evolve/reports/", async () => {
    const { stdout } = await auto("weekly");
    const file = stdout.trim().split("\n").pop() as string;
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toMatch(/Недельный отчёт evolve/);
  });

  it("status: БД доступна, последние прогоны в выводе", async () => {
    const { stdout } = await auto("status");
    expect(stdout).toMatch(/БД: доступна/);
    expect(stdout).toMatch(/ok: decay run/);
  });
});
