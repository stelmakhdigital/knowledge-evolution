---
name: evolve
description: "База знаний кодинг-агента (knowledge-evolution): проверенные уроки прошлых задач (миграции, схемы БД, git-гигиена, кэши, индексы, уроки из ревью/критика). Injection только через retrieve: гибридный поиск (FTS+pgvector), relevance-cutoff, budget-гварды. Использование записывается в телеметрию (usage_log → score → canary)."
whenToUse: Перед началом нетривиальной задачи, если тема пересекается с прошлыми проблемами проекта (БД/миграции, git, кэши, производительность, уроки ревью) — сначала запроси знания. Не используй, если задача тривиальная и не пересекается с темой.
---

# evolve — база знаний кодинг-агента

Адаптер: репозиторий `{{REPO}}` (после `npm run build`), команда
`inject knowledge`. Агент: `dsh` (профиль json; markdown — `--format markdown`).
БД: `{{DB}}`.

## Workflow

1. **Проверка доступности** (раз в сессию):
   ```bash
   node {{REPO}}/dist/cli.js inject knowledge \
     --db {{DB}} --agent dsh --query "selftest"
   ```
   Ошибка подключения к Postgres → убедитесь, что Postgres запущен и расширения
   `pgvector`/`pg_trgm` установлены (скрипт установки — `scripts/setup.sh` в
   репозитории). «(evolve: знаний не найдено…)» при selftest — нормально
   (нет релевантного).

2. **Запрос знаний** перед сложной задачей (1–3 ключевых слова темы, на языке
   базы; `--task` — стабильный id текущей задачи, один на задачу):
   ```bash
   node {{REPO}}/dist/cli.js inject knowledge \
     --db {{DB}} --agent dsh \
     --query "<тема задачи>" --task "<task-id>" --format markdown
   ```
   Ответ не пуст → знания учтены (они прошли гейты и canary); пуст → действуй
   без них. Ошибка/таймаут команды — НЕ блокируй задачу (ТЗ §19).

3. **После задачи** (если использовал знания и есть вердикт успеха):
   ```bash
   node {{REPO}}/dist/cli.js task verify "<task-id>" \
     --db {{DB}} --agent dsh \
     --success --verifier tests
   ```
   (успех по верификатору: тесты/CI/прогонка; self-reported — только
   `--verifier human` и с честной оценкой; ровно одно из --success/--fail).

4. **Новый урок** (если в задаче обнаружен новый проверенный урок):
   ```bash
   node {{REPO}}/dist/cli.js review record \
     --db {{DB}} \
     --task-id "<task-id>" --source human --rating 4 \
     --transcript-hash "sha256:<hash-транскрипта-задачи>" \
     --lesson "<подробное тело урока>" \
     --issue-type design --issue-severity low \
     --evidence "<file:line / тест / коммит>" \
     --type heuristic --scope "src/**" --agent dsh
   ```
   — кандидат пройдёт гейты (G1–G5); low-риск → canary, high → очередь
   человека. Не форсируй: дубли отклоняются (θ_dedup).

## Диагностика

- `EVOLVE_INJECT_DEBUG=1` — в stderr: N элементов, took_ms, timed_out.
- Отчёт: `node {{REPO}}/dist/cli.js report weekly --db {{DB}}` (success-rate по агентам).
- Аудит §14: `node {{REPO}}/dist/cli.js audit agent-agnostic --db {{DB}}`.

Ограничения: только чтение + телеметрия (запись знаний — только конвейер);
базы других проектов — отдельная БД (setup создаст).
