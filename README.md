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

# Человеческое решение из очереди
node dist/cli.js item transition <id> canary --reason "принято в недельном окне"
```

Коды выхода `item add`: 0 — accept/merge, 1 — reject (гейт не пройден) или ошибка.
`--verifier` обязателен для прохождения G1 (self-reported успех запрещён, ТЗ §9).

## Разработка

```bash
npm test          # vitest (юнит-тесты детерминированной логики)
npm run build     # tsc strict → dist/
```

Пороги и бюджеты — один файл `config.yaml` (все гейты параметризованы, ТЗ §5);
смена порога — коммит конфига + запись в `roadmap.md` §Решения.
