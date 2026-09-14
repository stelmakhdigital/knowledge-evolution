# harness-документ evolve (ТЗ §5.1)

Версируемый NL-документ политики harness (git-версируемый, diff-абельный).
Каждая смена политики — коммит с diff и ссылкой на данные (по мотиву
«Natural-Language Agent Harnesses»). Документ обязателен для ablation (§12.4),
transfer-тестов (§14.5) и meta-оптимизации (M6).

Числовые пороги — в `config.yaml` (change control: смена порога = коммит
конфига + запись в roadmap.md «Решения»). Документ описывает **логику**,
конфиг — **числа**.

## 1. Retrieval (инъекция знаний)

- Единственный путь использования знания — retrieval (запись usage_log ДО
  начала задачи); гибридный канал: полнотекст (FTS simple + pg_trgm) +
  векторный (pgvector, косинус, ленивый индекс по версиям) → RRF
  (1/(k+rank)) → финальный ранк `w_rrf·rrf + w_score·score(item, agent) +
  w_scope·scope − w_recency·recency`.
- В выдаче только `active`/`canary`; `applies_to` = 'all' | agent_id
  (поведенческие уроки — только под свой агент, §14.3).
- Budget-гварды обязательны: лимит на элемент, на общий объём, таймаут —
  по таймауту инъекция пропускается, задача не блокируется.
- Score: по паре (item, agent) из usage_log; без сигнала (used < min) —
  fallback на score_global.

## 2. Гейты (запись в базу)

Единственный путь создания item — кандидат + гейты (прямая запись в active
запрещена). Порядок: G1 evidence → G2 dedup → G4 scope → G5 budget → item →
G3 conflict → риск-решение (low → canary, high → queue).

- **G1 evidence**: верифицированный провенанс. success — task_id +
  transcript_hash + verifier (self-reported запрещён); review/critic —
  task_id + transcript_hash просмотренной задачи + rating 1..5.
- **G2 dedup**: cos_sim с базой ≥ θ_dedup → merge-предложение, не новый item.
- **G3 conflict**: LLM-детектор противоречий с active → contradictions.open;
  открытое > 7 дней — оба элемента в queue.
- **G4 scope**: широта scope → risk_tier (scope='all' у heuristic/skill — high).
- **G5 budget**: лимиты active/queue/кандидатов-на-агента-в-день (config.budget).

## 3. Canary (автоматический промоут)

Окно: 7 дней ИЛИ ≥ 3 извлечений (что наступит позже). Pass: извлечения ≥ 3 И
success-rate ≥ baseline − ε И cost-gate (стоимость ≤ baseline × 1.2) → active
(решение `auto:canary`). Fail → candidate + flag; повтор — только новым
кандидатом. Transfer-тест: top-20 по importance прогоняются на
альтернативном профиле; weak → тег `transfer:weak` (не блокирует).

## 4. Деградация (cron)

- 21 день без использования → deprecated; score < θ_score при used ≥ 5 →
  deprecated; 30 дней в deprecated → archived (причина обязательна, immutable).
- Открытое противоречие > 7 дней → активные участники в queue.
- Защита от over-pruning: не более 20% базы demotion за календарный месяц.
- **Rollback любого авто-решения — один клик** (`evolve rollback <id>`).

## 5. Критик и review

Критик — отдельный промпт/модель («найди, где сломается»), не привилегирован:
фидбэк проходит конвейер как обычный триггер. Качество измеряется
телеметрией: авто-вес (`critic reweight`) — gate-pass-rate lesson-кандидатов ×
usage-фактор (success на задачах с его уроками против baseline); ложные
issues снижают вес механически.

## 6. Ablation (§12.4)

Каждый активный модуль поддерживает режим off (флаг `config.ablation`,
неделя-эксперимент): изменение success-rate и стоимости/задачу при
отключённом модуле — ablation-отчёт. Отключение = коммит конфига (change
control), не код:

| модуль | флаг | эффект off |
|---|---|---|
| dedup | `ablation.dedup` | G2 пропускается (дубли возможны) |
| conflict | `ablation.conflict` | G3 пропускается (противоречия не детектируются) |
| canary | `ablation.canary` | low-кандидаты идут в queue (человек) вместо canary |
| critic | `ablation.critic` | lesson-кандидаты критика отклоняются на G1 |
| negative | `ablation.negative` | negative-элементы не попадают в выдачу |

## 7. Алерты и отчётность

Только сигналы, иначе система молчит (§12.2): budget, противоречия,
success-rate drop, churn, застой очереди, рост стоимости. Недельный отчёт:
success-rate по агентам, canary-итоги, churn, очередь, вес критика.

## 8. Agent-agnostic (hard, §14)

Схемы, конвейер, метрики не содержат ссылок на конкретного агента (агент =
`agent_id` + профиль); `applies_to` default 'all'; score на паре (item, agent);
смена агента = новый профиль + canary-репрогон top-50 (не полная база).
Проверка: `evolve audit agent-agnostic`.

## 9. Meta-оптимизация (M6, исследование)

Agentic proposer получает доступ к decisions/usage_log/gate_results/scores и
предлагает **кандидатные правки этого документа** (пороги, бюджеты, формат
инъекции, ablation-флаги). Каждый кандидат — новая версия документа в git +
diff в очередь человека; промоут только при success-rate на golden ≥ baseline +
5 п.п. И стоимости ≤ baseline (cost-gate). Proposer не меняет harness
напрямую — решения принимают человек + метрики.
