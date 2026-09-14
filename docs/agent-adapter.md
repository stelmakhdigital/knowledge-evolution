# Адаптер агента (Op.1): подключение evolve к реальному кодинг-агенту

Agent-agnostic (ТЗ §14): никакого хардкода конкретного агента — агент задаётся
`--agent <id>` + профилем `agent_profiles` (format/top_k/budget). Один и тот же
адаптер работает для DSH, Claude-Code, Copilot или любого другого агента.

## 1. Что получает агент

Команда **`evolve inject knowledge`** — единственный путь использования
знания (ТЗ §10.3): retrieval (hybrid FTS+pgvector → RRF → finalRank,
budget-гварды) + формат по профилю + запись `usage_log` (знание было доступно
**до** задачи). Таймаут/ошибка — пустой ответ, задача **не блокируется**
(ТЗ §19).

```bash
node <evolve>/dist/cli.js inject knowledge \
  --db "$EVOLVE_DB_URL" \
  --agent <agent_id> \
  --query "<вопрос/контекст текущей задачи>" \
  [--task <task_id>]        # usage_log: какой задачей знание было использовано
  [--format markdown|json|tool_call]  # иначе — формат профиля
```

Формат ответа — из `agent_profiles.format` (markdown / json / tool_call):

```sql
-- профиль агента (смена = коммит: change control)
INSERT INTO agent_profiles (agent_id, context_budget, retrieval_top_k, format)
VALUES ('dsh', 8000, 5, 'json')
ON CONFLICT (agent_id) DO NOTHING;
```

## 2. Рецепт для DSH (bash-инструмент)

> Установлен: `~/.dsh/skills/evolve/SKILL.md` (2026-09-14, Op.3a). Первый
> реальный цикл пройден на живой сессии: `task start` → `inject knowledge`
> (4 знания, 14 ms, usage_log) → `review record` (урок → canary) →
> `task verify` (success, верификатор tests) → `scores recompute`.

Системный промпт / скилл-инструкция для DSH-агента (копируется в
`~/.dsh/skills/evolve/SKILL.md` или в системный промпт сессии):

```markdown
## Знания (evolve) — когда обращаться
ПЕРЕД началом задачи, если тема пересекается с прошлыми проблемами проекта
(миграции, схемы БД, git-гигиена, кэши, индексы, уроки из прошлых задач):

1. Сформулируй запрос: 1–3 ключевых слова темы (на языке базы знаний).
2. Выполни: `node <evolve>/dist/cli.js inject knowledge --db "$EVOLVE_DB_URL"
   --agent dsh --query "<тема>" --task "<id-текущей-задачи>"`
3. Если ответ не пуст — учти эти знания (они проверены прошлыми задачами);
   если «(evolve: знаний не найдено…)» — действуй без них.
4. Не блокируй задачу при ошибке/таймауте команды.

После задачи верификатор помечает success (task verify) — телеметрия
обновляет score и canary автоматически.
```

Параметры:
- `<evolve>` — корень репозитория knowledge-evolution (после `npm run build`);
- `EVOLVE_DB_URL` — например `postgres://arka@127.0.0.1:5432/evolve`;
- `--agent dsh` — id агента; профиль должен существовать (иначе markdown);
- `--task` — стабильный id задачи сессии (один на всю задачу), чтобы
  вердикт success приписался к правильным знаниям.

## 3. Рецепт для других агентов (agent-agnostic)

Любой агент с bash-доступом: та же команда, `--agent <свой-id>`, профиль
своим форматом (tool_call → агент передаёт `arguments` в свой tool-слой;
markdown → вклеивается в контекст как есть). Поведенческие уроки
(`applies_to=<agent>`) попадут только этому агенту (ТЗ §14.3) — после
обучения на review/critic-триггерах.

## 4. Жизненный цикл

```
агент: inject (usage_log ДО задачи)
  → верификатор: task verify (success/fail → usage_log.task_success)
    → scores recompute / canary evaluate / decay (cron)
      → retrieval отдаёт только active/canary со свежим score
```

Запись знаний — только конвейер (ТЗ §8): extract/lesson + гейты →
canary → active. Адаптер — только чтение + телеметрия.

## 5. Диагностика

- `EVOLVE_INJECT_DEBUG=1 evolve inject …` — строка в stderr: N элементов,
  took_ms, timed_out;
- `report weekly` — success-rate по агентам (видит ли адаптер пользу);
- `audit agent-agnostic --db` — проверка §14 после смены профилей.
