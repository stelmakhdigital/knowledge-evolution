-- M1 (ТЗ §11.1): события телеметрии в Postgres.
-- Денормализованные task_id/agent_id — для поиска (listEvents по задаче);
-- полный объект события — payload (JSONB), схема валидации — src/domain/telemetry.ts.
CREATE TABLE IF NOT EXISTS events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,              -- task_started | knowledge_used | task_verified | review_recorded
  task_id    text NOT NULL,
  agent_id   text,                        -- не у всех типов событий (review_recorded)
  payload    jsonb NOT NULL,             -- полный объект события (zod-валидация на границе)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_task_idx ON events (task_id);
CREATE INDEX IF NOT EXISTS events_agent_idx ON events (agent_id);
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at);
