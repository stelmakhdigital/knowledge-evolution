#!/usr/bin/env bash
# install-auto.sh — установить systemd user-таймеры для автоматических циклов evolve:
#   evolve-daily.timer   — каждый день 03:30: scores recompute + canary evaluate + decay run
#   evolve-weekly.timer  — по воскресеньям 20:00: weekly report → ~/.evolve/reports/
# Persistent=true: прогоны, пропущенные пока система была выключена, выполняются при подъёме.
# После установки — «не трогай»: Postgres (Docker restart: unless-stopped) + таймеры
# делают всю работу сами, без участия человека.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${EVOLVE_AUTO_DB:-}"
[[ -z "$DB" && -f "$HOME/.evolve/db-url" ]] && DB="$(cat "$HOME/.evolve/db-url")"
[[ -n "$DB" ]] || { echo "нужен --db <url> или ~/.evolve/db-url (запустите npm run setup)" >&2; exit 1; }

command -v systemctl >/dev/null 2>&1 || { echo "systemd не найден: используйте cron:" >&2
  echo "  30 3 * * *   $REPO/scripts/auto.sh daily" >&2
  echo "  0 20 * * 0   $REPO/scripts/auto.sh weekly" >&2; exit 1; }

USERD="$HOME/.config/systemd/user"
mkdir -p "$USERD"

cat > "$USERD/evolve-daily.service" <<UNIT
[Unit]
Description=evolve: ежедневные циклы (scores/canary/decay)

[Service]
Type=oneshot
Environment=EVOLVE_AUTO_DB=$DB
ExecStart=$REPO/scripts/auto.sh daily
UNIT

cat > "$USERD/evolve-daily.timer" <<'UNIT'
[Unit]
Description=evolve: ежедневный прогон (03:30, Persistent — догоняет пропуски)

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
Unit=evolve-daily.service
UNIT

cat > "$USERD/evolve-weekly.service" <<UNIT
[Unit]
Description=evolve: недельный отчёт → ~/.evolve/reports/

[Service]
Type=oneshot
Environment=EVOLVE_AUTO_DB=$DB
ExecStart=$REPO/scripts/auto.sh weekly
UNIT

cat > "$USERD/evolve-weekly.timer" <<'UNIT'
[Unit]
Description=evolve: недельный отчёт (воскресенье 20:00, Persistent)

[Timer]
OnCalendar=Sun *-*-* 20:00:00
Persistent=true
Unit=evolve-weekly.service
UNIT

systemctl --user daemon-reload
systemctl --user enable --now evolve-daily.timer evolve-weekly.timer

cat <<DONE

Готово — evolve в режиме «не трогай»:
  evolve-daily.timer   — ежедневно 03:30 (scores recompute, canary evaluate, decay run)
  evolve-weekly.timer  — воскресенье 20:00 (отчёт в ~/.evolve/reports/report-<дата>.md)
  Postgres             — Docker: restart: unless-stopped (поднимается после рестарта сам)

Статус: systemctl --user list-timers | grep evolve ; $REPO/scripts/auto.sh status
Снять:  systemctl --user disable --now evolve-daily.timer evolve-weekly.timer

Важно: user-таймеры работают, когда есть сессия пользователя. Чтобы выполнялись
без логина (сразу после включения ПК):
  sudo loginctl enable-linger \$USER
DONE
