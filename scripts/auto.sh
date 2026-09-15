#!/usr/bin/env bash
# auto.sh — автоматические циклы evolve (системные таймеры / cron / вручную).
#   auto.sh daily   — scores recompute + canary evaluate + decay run (ежедневно)
#   auto.sh weekly  — weekly report → ~/.evolve/reports/report-YYYY-MM-DD.md
#   auto.sh status  — состояние: БД доступна? когда последний прогон?
# ensure-db: если Postgres лег — поднимает (docker compose → pg_ctl home-кластера).
# Лог: ~/.evolve/auto.log.

set -euo pipefail

AUTO_DIR="$HOME/.evolve"
LOG="$AUTO_DIR/auto.log"
DB="${EVOLVE_AUTO_DB:-}"
REPO="${EVOLVE_AUTO_REPO:-}"

if [[ -z "$DB" && -f "$AUTO_DIR/db-url" ]]; then DB="$(cat "$AUTO_DIR/db-url")"; fi
if [[ -z "$REPO" && -f "$AUTO_DIR/repo" ]]; then REPO="$(cat "$AUTO_DIR/repo")"; fi
[[ -n "$DB" && -n "$REPO" ]] || { echo "[auto] не найдано ~/.evolve/{db-url,repo}: запустите 'npm run setup' (scripts/setup.sh)" >&2; exit 1; }

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

die() { log "ОШИБКА: $1"; exit 1; }

command -v node >/dev/null 2>&1 || die "node не найден"
[[ -f "$REPO/dist/cli.js" ]] || die "нет $REPO/dist/cli.js (npm run build)"

# --- ensure-db: поднять Postgres, если лег ------------------------------------------------
ensure_db() {
  local host port
  read -r host port < <(node -p 'const u = new URL(process.argv[1]); u.hostname + " " + (u.port || "5432")' "$DB")
  if node -e '
      const net = require("net");
      const s = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]), timeout: 1500 });
      s.on("connect", () => { s.end(); process.exit(0); });
      s.on("timeout", () => { s.destroy(); process.exit(1); });
      s.on("error", () => process.exit(1));
    ' "$host" "$port" 2>/dev/null; then
    return 0;
  fi
  echo "[auto] БД $host:$port недоступна — пытаюсь поднять…" | tee -a "$LOG"
  if command -v docker >/dev/null 2>&1 && [[ -f "$REPO/docker-compose.yml" ]]; then
    (cd "$REPO" && docker compose up -d >/dev/null 2>&1) && sleep 3 && \
    node -e '
      const net = require("net");
      const s = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]), timeout: 15000 });
      s.on("connect", () => { s.end(); process.exit(0); });
      s.on("timeout", () => { s.destroy(); process.exit(1); });
      s.on("error", () => process.exit(1));
    ' "$host" "$port" 2>/dev/null && { log "БД поднята: docker compose up -d"; return 0; }
  fi
  if [[ -x "$HOME/.pgsql/bin/pg_ctl" && -d "$HOME/pgsql/data" ]]; then
    "$HOME/.pgsql/bin/pg_ctl" -D "$HOME/pgsql/data" \
      -o "-p $port -k $HOME/pgsql/sock -c listen_addresses=127.0.0.1" \
      -l /tmp/pg-server.log start >/dev/null 2>&1 && \
    { log "БД поднята: pg_ctl (home-кластер)"; return 0; }
  fi
  die "не удалось поднять Postgres ($host:$port): запустите docker (systemctl enable docker) или home-кластер вручную"
}

run_cli() { # проксируем вывод в лог и на stdout
  local out
  out="$(cd "$REPO" && EVOLVE_DB_URL="$DB" node dist/cli.js "$@" 2>&1)" \
    || { log "ОШИБКА CLI ($*): $out"; exit 1; }
  log "ok: $* → $(echo "$out" | head -1)"
}

cmd="${1:-status}"
case "$cmd" in
  daily)
    mkdir -p "$AUTO_DIR"
    ensure_db
    run_cli scores recompute
    run_cli canary evaluate
    run_cli decay run
    ;;
  weekly)
    mkdir -p "$AUTO_DIR/reports"
    ensure_db
    out="$AUTO_DIR/reports/report-$(date +%Y-%m-%d).md"
    (cd "$REPO" && EVOLVE_DB_URL="$DB" node dist/cli.js report weekly > "$out" 2>>"$LOG") \
      || { log "ОШИБКА: report weekly"; exit 1; }
    log "ok: report weekly → $out"
    echo "$out"
    ;;
  status)
    if [[ -f "$LOG" ]]; then
      echo "последние прогоны:"; tail -5 "$LOG"
    else
      echo "ещё не было прогонов ($LOG)"
    fi
    node -e '
      const net = require("net");
      const s = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]), timeout: 1500 });
      s.on("connect", () => { s.end(); console.log("БД: доступна"); process.exit(0); });
      s.on("timeout", () => { s.destroy(); console.log("БД: НЕдоступна"); process.exit(0); });
      s.on("error", () => { console.log("БД: НЕдоступна"); process.exit(0); });
    ' "$(node -p 'const u = new URL(process.argv[1]); u.hostname' "$DB")" \
      "$(node -p 'const u = new URL(process.argv[1]); u.port || "5432"' "$DB")"
    ;;
  *)
    echo "использование: auto.sh <daily|weekly|status>"; exit 2 ;;
esac
