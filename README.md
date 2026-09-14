# evolve — система эволюции знания для кодинг-агента

Накапливает, верифицирует и применяет знания (скиллы, хурики, уроки, факты,
предложения тулов) из успешно выполненных задач — чтобы агент со временем
выполнял задачи успешнее и дешевле. Детали: `knowledge-evolution-tz.md` (ТЗ v0.3),
состояние проекта — `roadmap.md` и `PROJECT_MEMORY.md`.

## Статус: M0 (каркас)

Готово (M0):
- доменная модель и стейт-машина статусов (`candidate→queued/canary→active→deprecated→archived`),
  запись в `decisions` на каждый переход (ТЗ §7.2.3, §9);
- гейты G1–G5 на детерминированном mock-LLM: evidence, dedup, conflict, scope, budget
  (ТЗ §9) + `admitCandidate` (кандидат → item → low→canary / high→queued);
- единый YAML-конфиг всех порогов/бюджетов (ТЗ §5, §19) с zod-валидацией;
- in-memory store (инварианты ТЗ §7.2/§8) + DDL `db/schema.sql` (Postgres — M2);
- CLI `evolve`: `item add/list/show/transition/allowed`.

Не готово: M1 (LLM-экстрактор, триггер успеха), M2 (Postgres+pgvector, `/retrieve`, canary-цикл),
M3 (отчётность/алерты/drift), M4 (критик), M5/M6.

## Установка

```bash
npm install
npm run build
```

## Использование (M0)

Состояние — локальный файл `.evolve/state.json` (можно переопределить `--state`
или `EVOLVE_STATE`; с M2 источник правды — Postgres).

```bash
# Кандидат: fact с узким scope → low risk → canary
node dist/cli.js item add "миграции лежат в db/migrations" \
  --type fact --scope "src/db/**" --body "миграции лежат в db/migrations, формат foo" \
  --task-id task-42 --transcript-hash sha256:abc --commit deadbeef \
  --verifier tests --agent dsh

# Кандидат: negative → high risk → очередь (человек)
node dist/cli.js item add "никогда не удаляй миграцию" \
  --type negative --scope "src/db/**" --body "никогда не удаляй миграцию" \
  --task-id task-43 --transcript-hash sha256:def --commit deadbeef \
  --verifier tests --agent dsh

node dist/cli.js item list
node dist/cli.js item list --status queued
node dist/cli.js item show <id>        # white-box: body + провенанс + decisions (ТЗ §7.2.6)
node dist/cli.js item allowed <id>     # допустимые следующие статусы

# Человеческое решение из очереди (недельное окно, ТЗ §12.1)
node dist/cli.js queue list                 # карточки: age, цена бездействия, STALE>14д
node dist/cli.js queue show <id>             # body, провенанс, гейты, противоречия
node dist/cli.js queue accept <id> --reason "принято в недельном окне"
node dist/cli.js queue accept-edit <id> --body "исправленное тело" --reason "сужили scope"
node dist/cli.js queue reject <id> --reason "причина (обязательная, идёт в decisions)"
node dist/cli.js item transition <id> canary --reason "принято в недельном окне"
```

### Телеметрия и экстрактор (M1)

```bash
node dist/cli.js task start <taskId> --agent dsh
node dist/cli.js task use <taskId> --agent dsh --item <itemId>   # запись ДО начала задачи
node dist/cli.js task verify <taskId> --agent dsh --success --verifier tests --verifier-id vitest
node dist/cli.js task show <taskId>

# Экстрактор: транскрипт завершённой задачи → кандидаты → гейты
node dist/cli.js extract run --task-id task-99 --transcript-file /tmp/transcript.txt \
  --verifier tests --commit abc123 --agent dsh
```

Коды выхода `item add` / `extract run`: 0 — accept/merge, 1 — reject (гейт не пройден) или ошибка.
`--verifier` обязателен для прохождения G1 (self-reported успех запрещён, ТЗ §9).

## Score и canary (M2)

Score по (item, agent) из usage_log (ТЗ §11.3): `0.5·success_rate(used≥5) +
0.3·usage_norm + 0.2·recency`; без сигнала (used < min_used) — fallback на
score_global. Пересчёт идемпотентный (`scores recompute`), источник правды —
usage_log (score не правится вручную, ТЗ §7.2.4).

Canary-цикл (ТЗ §9/§9.1): окно 7д + min 3 извлечения + ε=5% против baseline
(success-rate активного ядра) + cost-gate ×1.2 (M2-прокси — длина тела vs
среднее по active). Решения — `auto:canary` в decisions: pass → active,
fail → candidate (flag), мало данных — hold.

```bash
node dist/cli.js scores recompute
node dist/cli.js scores show <itemId> --agent dsh
node dist/cli.js canary evaluate
```

## Retrieval (M2)

Hybrid-поиск (ТЗ §10.1): keyword-канал (FTS `simple` + pg_trgm) + vector-канал
(pgvector, cosine, ленивое индексирование версий) → RRF-фьюжн → финальный ранк
по весам `config.retrieval` (`rrf_rank/item_score/scope_match/recency_decay`).
Извлекаются только active/canary; `applies_to`: 'all' | agent_id (ТЗ §14.2).
Budget-гварды (ТЗ §19): per-item/total-обрезка тел, timeout (деградация —
пустой ответ, задача не блокируется). С `task_id` — запись usage_log
(знание доступно ДО задачи, ТЗ §10.3).

```bash
node dist/cli.js retrieve --query "как безопасно изменить схему БД" --agent dsh --task-id t1
node dist/cli.js retrieve --query "секреты и .env" --agent dsh --format markdown
node dist/cli.js serve --port 3100   # HTTP: POST /retrieve, GET /health
curl -s -X POST http://127.0.0.1:3100/retrieve -d '{"query":"...","agent_id":"dsh","task_id":"t1"}'
```

Golden-критерий M2 (recall@5 ≥ 0.7 на 30 задачах, ТЗ §15) —
`test/retrieval.test.ts` + фикстура `test/golden/` (на живом PG).

## Postgres (M2)

Схема — `db/schema.sql` (контракт, TЗ §7.1), миграции — `db/migrations/`
(применяются `evolve migrate`, идемпотентно, журнал `schema_migrations`).

Локальный dev-кластер (этого репо, без sudo): Postgres 16.9 + pgvector 0.7.4
собраны в `~/.pgsql`, данные в `~/pgsql/data`, порт 5432, БД — `evolve`
(тесты — `evolve_test`, создаётся автоматически):

```bash
# поднять кластер (если не работает)
~/.pgsql/bin/pg_ctl -D ~/pgsql/data -o "-p 5432 -k $HOME/pgsql/sock -c listen_addresses=127.0.0.1" -l /tmp/pg-server.log start

# применить миграции
node dist/cli.js migrate
node dist/cli.js migrate --db "postgres://arka@127.0.0.1:5432/<db>"
```

Переменные: `EVOLVE_DB_URL` — connection string по умолчанию для `migrate`;
`EVOLVE_TEST_DB_URL`/`EVOLVE_ADMIN_URL` — для контракт-тестов PG (без живого
Postgres PG-сьют пропускается, остальные тесты не зависят от БД).

`PgStore` (`src/store/pg-store.ts`) — асинхронная реализация контракта
хранилища (`AsyncStore`, `src/store/async-store.ts`) на том же DDL; инварианты
ТЗ §7.2 зеркалят MemoryStore и страхуются DDL (triggers/CHECK). Retrieval-
сервис и переход CLI на Postgres — M2.2/M2.4.

## Разработка

```bash
npm test          # vitest (юнит-тесты детерминированной логики)
npm run build     # tsc strict → dist/
```

Пороги и бюджеты — один файл `config.yaml` (все гейты параметризованы, ТЗ §5);
смена порога — коммит конфига + запись в `roadmap.md` §Решения.
