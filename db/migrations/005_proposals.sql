-- 005: proposals — очередь кандидатов правок harness (M6, ТЗ §15)
-- Proposer (src/meta/proposer.ts) предлагает правки harness.md/config.yaml
-- (пороги, бюджеты, ablation-флаги) на основе telemetry. Кандидат = новая
-- версия политики в git + diff в очередь человека; proposer не меняет
-- harness напрямую (решения: человек + метрики, harness.md §9).

CREATE TABLE IF NOT EXISTS proposals (
  id           text PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  target       text NOT NULL,           -- например config.theta_dedup, harness.md §3
  field        text NOT NULL,           -- конкретный параметр
  old_value    text NOT NULL,
  new_value    text NOT NULL,
  rationale    text NOT NULL,           -- объяснение для человека
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed', 'accepted', 'rejected', 'applied')),
  decided_by   text,                    -- 'human:<name>'
  decided_at   timestamptz,
  notes        text
);

CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals (status, created_at);
