#!/usr/bin/env bash
# setup.sh — бутстрап knowledge-evolution на новой машине (идемпотентно).
# Шаги: Postgres (проверка) → БД → миграции → профиль агента → DSH-скилл.
#
# Использование:
#   npm run setup                                   # всё по умолчанию
#   npm run setup -- --db postgres://me@localhost:5432/evolve
#   npm run setup -- --skip-skill                   # без установки скилла
#   npm run setup -- --skills-dir ~/.dsh/skills --agent dsh --format json
#
# Переменные окружения: PSQL (путь к psql), EVOLVE_SKILL_DIR (то же, что --skills-dir).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="postgres://${USER:-arka}@127.0.0.1:5432/evolve"
AGENT="dsh"
FORMAT="json"
SKILLS_DIR="${EVOLVE_SKILL_DIR:-$HOME/.dsh/skills}"
SKIP_SKILL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    --skills-dir) SKILLS_DIR="$2"; shift 2 ;;
    --skip-skill) SKIP_SKILL=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "неизвестный аргумент: $1 (см. --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
die()  { printf '\n\033[31m[setup] %s\033[0m\n' "$1" >&2; exit 1; }

# --- 1) зависимости ---------------------------------------------------------
step "зависимости"
command -v node >/dev/null 2>&1 || die "node не найден (нужен Node 18+, рекомендуется 22)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || die "Node $NODE_MAJOR слишком стар (нужен 18+)"
echo "node $(node -v) ✓"

if [[ ! -f "$REPO/dist/cli.js" ]]; then
  echo "dist/cli.js нет — собираю (npm run build)…"
  (cd "$REPO" && npm run build --silent)
fi
[[ -f "$REPO/dist/cli.js" ]] || die "npm run build не дал dist/cli.js"
echo "dist/cli.js ✓"

PSQL="${PSQL:-}"
if [[ -z "$PSQL" ]]; then
  for c in "$HOME/.pgsql/bin/psql" "$(command -v psql || true)"; do
    [[ -n "$c" && -x "$c" ]] && { PSQL="$c"; break; }
  done
fi
[[ -n "$PSQL" ]] || die "psql не найден: установите PostgreSQL 16 (или export PSQL=/путь/к/psql). Рецепт сборки из исходников — README «Быстрый старт», шаг 2."
echo "psql: $PSQL ✓"

# --- 2) сервер + БД ----------------------------------------------------------
step "Postgres: сервер и база"

# host/port из --db URL (node — надёжный парсер); PSQL_OPTS — оверрайт
# (например, сокет: PSQL_OPTS="-h ~/pgsql/sock -p 5432")
read -r PG_HOST PG_PORT < <(node -p 'const u = new URL(process.argv[1]); u.hostname + " " + (u.port || "5432")' "$DB")
PSQL_ARGS=()
if [[ -n "${PSQL_OPTS:-}" ]]; then
  read -r -a PSQL_ARGS <<< "$PSQL_OPTS"
else
  PSQL_ARGS=(-h "$PG_HOST" -p "$PG_PORT")
fi

"$PSQL" "${PSQL_ARGS[@]}" -Atc "SELECT 1" postgres >/dev/null 2>&1 \
  || die "Postgres недоступен ($PG_HOST:$PG_PORT): запустите кластер (рецепт — README «Быстрый старт», шаг 2); сокет-подключение: PSQL_OPTS='-h <sock-dir> -p <порт>' npm run setup"
echo "сервер отвечает ✓ ($PG_HOST:$PG_PORT)"

# имя БД из URL: postgres://user@host:port/name
DB_NAME="${DB##*/}"
[[ "$DB_NAME" == *? ]] || die "не удалось разобрать имя БД из --db: $DB"

if "$PSQL" "${PSQL_ARGS[@]}" -Atc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" postgres | grep -q 1; then
  echo "БД $DB_NAME — уже существует"
else
  "$PSQL" "${PSQL_ARGS[@]}" -qc "CREATE DATABASE $DB_NAME" postgres
  echo "БД $DB_NAME создана"
fi

# расширения (нужны привилегии; если нет — сообщим, как починить)
if ! "$PSQL" "${PSQL_ARGS[@]}" -Atc "SELECT count(*) FROM pg_extension WHERE extname IN ('vector','pg_trgm')" "$DB_NAME" | grep -q '^2$'; then
  echo "устанавливаю расширения vector + pg_trgm…"
  "$PSQL" "${PSQL_ARGS[@]}" -qc "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;" "$DB_NAME" \
    || die "не удалось создать расширения (нужен owner БД/суперпользователь): CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;"
fi
echo "расширения vector + pg_trgm ✓"

# --- 3) миграции -------------------------------------------------------------
step "миграции"
# EVOLVE_DB_URL, а не --db: глобальный flag в CLI перехватывается program-опцией
# (commander), дефолт субкоманды скрывает значение — env читается как default.
(cd "$REPO" && EVOLVE_DB_URL="$DB" node dist/cli.js migrate)

# --- 4) профиль агента --------------------------------------------------------
step "профиль агента ($AGENT, format=$FORMAT)"
if "$PSQL" "${PSQL_ARGS[@]}" -Atc "SELECT 1 FROM agent_profiles WHERE agent_id = '$AGENT'" "$DB_NAME" | grep -q 1; then
  echo "профиль $AGENT — уже существует (не трогаем; правьте руками: change control)"
else
  "$PSQL" "${PSQL_ARGS[@]}" -qc "INSERT INTO agent_profiles (agent_id, context_budget, retrieval_top_k, format)
              VALUES ('$AGENT', 8000, 5, '$FORMAT')
              ON CONFLICT (agent_id) DO NOTHING;" "$DB_NAME"
  echo "профиль $AGENT создан (top_k=5, budget=8000, format=$FORMAT)"
fi

# --- 5) DSH-скилл --------------------------------------------------------------
if [[ "$SKIP_SKILL" -eq 1 ]]; then
  echo "скилл: пропущен (--skip-skill)"
else
  step "DSH-скилл ($SKILLS_DIR/evolve/SKILL.md)"
  mkdir -p "$SKILLS_DIR/evolve"
  TARGET="$SKILLS_DIR/evolve/SKILL.md"
  [[ -f "$TARGET" ]] && cp "$TARGET" "${TARGET}.bak-$(date +%s)" && echo "старый SKILL.md → ${TARGET}.bak-…"
  sed -e "s|{{REPO}}|$REPO|g" -e "s|{{DB}}|$DB|g" "$REPO/scripts/skill-template.md" > "$TARGET"
  echo "скилл установлен: $TARGET"
fi

# --- 6) smoke-тест --------------------------------------------------------------
step "smoke-тест"
if EVOLVE_DB_URL="$DB" node "$REPO/dist/cli.js" inject knowledge --agent "$AGENT" --query "selftest" >/dev/null 2>&1; then
  echo "inject knowledge — работает ✓"
else
  echo "inject knowledge вернул пусто/ошибку (пустая база — нормально; ошибка подключения — нет):"
  EVOLVE_DB_URL="$DB" node "$REPO/dist/cli.js" inject knowledge --agent "$AGENT" --query "selftest" || true
fi

cat <<EOF

Готово. Дальше:
  1. Новый урок:   node $REPO/dist/cli.js review record --db $DB --task-id <t> --source human --rating 4 --transcript-hash sha256:x --lesson "..." (рецепты — SKILL.md)
  2. Инъекция:     node $REPO/dist/cli.js inject knowledge --db $DB --agent $AGENT --query "<тема>" --task <t>
  3. Отчёт:        node $REPO/dist/cli.js report weekly --db $DB
  Подсказка: --db в CLI — глобальный флаг commander; если субкоманда "не видит"
  значение, используйте env: EVOLVE_DB_URL=$DB node dist/cli.js <команда>
  Подробности: README «Быстрый старт» + docs/agent-adapter.md
EOF
