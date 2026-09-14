-- M2 (ТЗ §7.2.4, §15 M2): телеметрия-score по (item, agent) из usage_log.
-- Пересчёт идемпотентный (recomputeScores): таблица — производная от usage_log,
-- источник правды остаётся usage_log (score не «правится» вручную, TЗ §7.2.4).
CREATE TABLE IF NOT EXISTS item_scores (
  item_id     uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  agent_id    text NOT NULL,
  score       real,                          -- NULL, пока used < min_used (нет сигнала)
  used        integer NOT NULL CHECK (used >= 0),
  components  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- success_rate, usage_norm, recency
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, agent_id)
);

CREATE INDEX IF NOT EXISTS item_scores_item_idx ON item_scores (item_id);
CREATE INDEX IF NOT EXISTS item_scores_agent_idx ON item_scores (agent_id);
