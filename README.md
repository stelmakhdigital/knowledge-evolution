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

## Авто-вес критика (M4.2)

Еженедельный пересчёт `critic_weight` по телеметрии (ТЗ §13/§15 M4):
`weight = base × (0.5 + 0.5 × gate_pass_rate) × usage_factor` — gate-pass-rate
(доля lesson-кандидатов критика, прошедших конвейер; merge/reject — не прошли)
и usage-фактор (success-rate задач, где использовались lesson-элементы критика,
против общего success-rate; clamp 0.5..1.5; < 5 вердиктов — 1.0). Итог clamp
0.1..2.0; пересчёт идемпотентный (`critic_weights` — производная от телеметрии).
Новые critic-ревью используют последний пересчитанный вес (в провенансе),
вес-механика видна в `report weekly` (секция «Критик»):

```bash
node dist/cli.js critic reweight --db "$EVOLVE_DB_URL"
node dist/cli.js report weekly --db "$EVOLVE_DB_URL"   # секция «Критик»
```

## Review-триггер и критик (M4)

Структурированный фидбэк человека или критик-агента (ТЗ §13): оценка 1..5 +
issues (type/severity/evidence/lesson_candidate) → событие `review_recorded` +
каждый lesson — обычный кандидат через конвейер (критик — «ещё один источник,
не привилегированный»). G1 для review/critic: верификация = task_id +
transcript_hash просмотренной задачи + rating. `critic_weight` (config.critic)
сохраняется в провенанс — основа авто-веса критика и отчёта (ТЗ §15 M4).

```bash
node dist/cli.js review record --db "$EVOLVE_DB_URL" \
  --task-id t1 --source critic --rating 2 \
  --transcript-hash sha256:… --commit cafe \
  --lesson "проверять код ответа БД перед кэшированием" \
  --issue-type bug --issue-severity high --evidence "src/api/handler.ts:42"
```

heuristic с scope=all → risk=high → queue (ручное ревью команды);
повторный lesson → merge (G2), issue без lesson — только телеметрия.

## LLM-пропонер (M6.2)

Поверх детерминированных правил (M6.1) — LLM-пропонер, оперирующий
**harness-документом** и телеметрией (ТЗ §5.1/§15, harness.md §9):
промпт-контекст = `collectSignals` (те же 30-дневные сигналы) + вырез
`harness.md`. Валидация каждого кандидата: whitelist полей (только параметры
политик: θ, canary, degradation, retrieval, budget, ablation), границы,
old_value = актульное значение из конфига, нет no-change и дублей в прогоне.
Валидные — в ту же очередь `proposals` (idempotency по field+new_value).
Proposer не меняет harness напрямую: очередь человека + промоут по
golden-эвалуации (success-rate ≥ baseline + 5 п.п. И cost ≤ baseline).
Реальный LLM — реализация интерфейса `HarnessProposer` поверх API; в
репозитории — детерминированный `MockHarnessProposer` (тесты, оффлайн).

```bash
node dist/cli.js meta propose --llm --db "$EVOLVE_DB_URL"
# ✗ (llm mock) items.max_length: поле не в whitelist harness
# + (llm mock) retrieval.top_k: 5 → 4  (валидные кандидаты)
```

## Meta-оптимизация: proposer (M6.1)

Agentic proposer (ТЗ §15/M6, harness.md §9) читает telemetry за 30 дней
(`gate_results`, `usage_log`, `decisions`, бюджеты) и предлагает **кандидатные
правки harness** в очередь человека: proposer не меняет harness напрямую —
решения принимают человек + метрики (промоут правки только при success-rate
на golden ≥ baseline + 5 п.п. И cost ≤ baseline). M6.1 — детерминированные
правила по сигналам (LLM-пропонер — M6.2, интерфейс готов):

- S1: G2 pass < 50% (≥10) → поднять `theta_dedup` на 0.05 (дедуп-шум);
- S2: active > 80% бюджета → ускорить деградацию (`theta_score` −0.05);
- S3: success-rate агента < baseline − 0.1 (verdicts ≥ 10) → недельный
  ablation-эксперимент (`ablation.negative: false`, ТЗ §12.4);
- S4: canary demote ≥ 30% (≥5) → поднять `canary.min_retrievals`.

Каждое предложение: тема/поле, old → new, rationale + evidence (ссылка на
данные); идемпотентность по (field, new_value) в активном статусе.

```bash
node dist/cli.js meta propose --db "$EVOLVE_DB_URL"
node dist/cli.js meta proposals --db "$EVOLVE_DB_URL" [--status proposed]
node dist/cli.js meta apply <id> --by human:name --notes "golden-эвалуация: +6 п.п."
node dist/cli.js meta reject <id> --notes "нет данных"
```

`apply` — решение человека: запись `proposals` (status=applied) + напоминание
внести правку в `config.yaml`/`harness.md` и закоммитить (change control).

## Harness-документ и ablation (M6.0)

Политика harness зафиксирована в **`harness.md`** (ТЗ §5.1): NL-документ,
git-версируемый, diff-абельный; пороги — в `config.yaml` (change control:
смена политики = коммит + запись в roadmap.md «Решения»). Документ обязателен
для ablation (§12.4), transfer-тестов (§14.5) и meta-оптимизации (M6:
proposer предлагает правки именно этого документа).

Ablation (ТЗ §12.4): каждый модуль поддерживает режим off на неделю
(`config.ablation`): dedup (G2), conflict (G3), canary (off → low в queue),
critic (lesson-кандидаты критика отклоняются на G1), negative (не в выдаче
retrieval). Смена флага = правка config.yaml + коммит:

```bash
node dist/cli.js ablation list
```

## Адаптер агента (Op.1)

Подключение evolve к реальному кодинг-агенту — agent-agnostic (ТЗ §14):
агент = `--agent <id>` + профиль `agent_profiles`. Полная инструкция:
[`docs/agent-adapter.md`](docs/agent-adapter.md) (рецепты DSH + любого агента,
жизненный цикл, диагностика).

```bash
node dist/cli.js inject knowledge --db "$EVOLVE_DB_URL" \
  --agent dsh --query "тема задачи" [--task <task_id>] [--format markdown|json|tool_call]
```

- формат/ top_k / budget — из профиля (без профиля — markdown);
- relevance-cutoff (Op.2): `retrieval.min_final_score` в config — элементы с
  finalRank ниже порога не в выдачу (0 = off, по умолчанию); без cutoff
  nearest-neighbor всегда что-то возвращает;
- `--task` — запись `usage_log` (знание доступно ДО задачи, ТЗ §10.3);
- таймаут/ошибка — пустой ответ, задача не блокируется (ТЗ §19);
- `EVOLVE_INJECT_DEBUG=1` — диагностика в stderr (N элементов, took_ms).

## Transfer-тест (M5)

Проверка переноса знаний на альтернативный профиль (ТЗ §14.5): top-20
active-элементов по importance (usage-подсчёт, score_global) прогоняются через
реальный `retrieve()` на другом `agent_profile` (self-recall: запрос =
title + tags). Перенёсся — `transferred`; нет — тег `transfer:weak`
(не блокирует active, попадает в месячный аудит). `applies_to=<агент>` по
определению не переносится (поведенческий урок, ТЗ §14.3) → `weak_excluded`.
Профиль должен существовать в `agent_profiles` (harness исполним в профилях
≥ 2 моделей — hard requirement):

```bash
node dist/cli.js transfer eval --db "$EVOLVE_DB_URL" --profile claude [--limit 20]
```

## Agent-agnostic audit (M5)

Автоматическая проверка hard-requirements ТЗ §14 (агент = `agent_id` + профиль,
никакого хардкода агентов в схемах/конвейере/метриках):

1. `no-hardcoded-agents` — конвейерный код (16 папок src/) без литералов агентов;
2. `applies-to-default` — DDL `applies_to DEFAULT 'all'`;
3. `retrieval-filters-applies-to` — фильтр `'all' | agent_id` в retrieval;
4. `score-per-pair` — `item_scores` PK (item_id, agent_id) (статика + живая БД);
5. `agent-profiles` — таблица профилей + сервис использует профиль;
6. `applies-to-values` (с БД) — нет пустых/NULL applies_to.

```bash
node dist/cli.js audit agent-agnostic [--db "$EVOLVE_DB_URL"]   # exit 1 при сбое
```

## Недельный отчёт и алерты (M3)

`report weekly` — сводка за 7 дней (ТЗ §15 M3: «недельное окно ≤ 20 минут»):
success-rate по агентам (вердикты верификатора), canary-итоги (auto-решения),
churn (demotion/auto:degradation), застой очереди (> 14д в queue) и алерты по
`config.alerts` (ТЗ §12.2: «только сигналы, иначе система молчит»):
active > 90% бюджета, открытые противоречия > 5, −5% success-rate за 2 нед при
росте базы, > 5 demotion/нед, карточка в queue > 14д, рост стоимости > 15%
(М3-прокси стоимости: средняя длина inject-тел на запрос).

```bash
node dist/cli.js report weekly --db "$EVOLVE_DB_URL"          # markdown
node dist/cli.js report weekly --db "$EVOLVE_DB_URL" --json   # JSON
```

## Decay и rollback (M3)

Decay (деградация, ТЗ §9/§16) — ежедневная авто-логика по active-базе:
- **unused**: ≥ 21д без использования (usage/создание) → `deprecated`;
- **θ_score**: `score_global < 0.3` при used ≥ 5 → `deprecated`;
- **archived**: ≥ 30д в deprecated → `archived` (с archived_reason, ТЗ §7.2.1);
- **contradiction**: открытое противоречие > 7д → активные участники в queue;
- **over-pruning guard**: не более 0.2 × базы demotion за календарный месяц (ТЗ §16).

Все решения — `actor=auto:degradation` в decisions; **rollback одним кликом**
(ТЗ §15 M3):

```bash
node dist/cli.js decay run --db "$EVOLVE_DB_URL"
node dist/cli.js rollback <itemId> --db "$EVOLVE_DB_URL" [--reason "…"]
```

Rollback: `deprecated → active` (kind=rollback, actor=human) — специальное ребро
стейт-машины для «возврата из недельного окна» (ТЗ §12.1).

## Режим Postgres в CLI (M2.4)

Все команды работают и в memory-режиме (JSON-снимок, по умолчанию), и в
Postgres-режиме: добавьте `--db <url>` (или переменная `EVOLVE_DB_URL`):

```bash
node dist/cli.js item add "…" --db "$EVOLVE_DB_URL" --type fact --scope "src/db/**" --body "…" \
  --task-id t1 --transcript-hash sha256:x --commit deadbeef --verifier tests
node dist/cli.js item list --db "$EVOLVE_DB_URL"
node dist/cli.js task use t1 --db "$EVOLVE_DB_URL" --agent dsh --item <id>
node dist/cli.js task verify t1 --db "$EVOLVE_DB_URL" --agent dsh --success --verifier tests
node dist/cli.js extract run --db "$EVOLVE_DB_URL" --task-id t1 --transcript "…" --verifier tests
node dist/cli.js queue list --db "$EVOLVE_DB_URL"
node dist/cli.js scores recompute --db "$EVOLVE_DB_URL"
node dist/cli.js canary evaluate --db "$EVOLVE_DB_URL"
```

Единый путь кода: хранилище — `AsyncStore` (PgStore) либо
`asyncStoreOf(MemoryStore)`; гейты/очередь работают с обоими.

End-to-end (демо 14.09): `item add` → canary → `task use/verify` ×5 →
`scores recompute` → `canary evaluate` → **active** (auto:canary, decision в
аудите). Критерий M2: canary-цикл без ручного вмешательства — `canary evaluate`.

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
