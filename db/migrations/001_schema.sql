-- ============================================================================
-- evolve — схема БД (ТЗ §7.1), PostgreSQL 16 + pgvector.
-- Миграции выполняются с M2; в M0 файл — источник правды по контракту,
-- in-memory store (src/store) следует тем же инвариантам (ТЗ §7.2, §8).
--
-- Инварианты (ТЗ §7.2):
--  * жёсткого DELETE нет: только status='archived' + archived_reason;
--  * тело версии иммутабельно: изменение — новая строка item_versions;
--  * каждое изменение статуса — строка в decisions;
--  * score пересчитывается из usage_log (idemпотентный cron), не «правится» вручную;
--  * embedding — на версию, не на item.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector: индекс, НЕ источник правды
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- полнотекст по body (FTS-канал, ТЗ §10.1)

-- ----------------------------------------------------------------------------
-- items
-- ----------------------------------------------------------------------------
CREATE TABLE items (
  id              uuid PRIMARY KEY,
  type            text NOT NULL
                  CHECK (type IN ('skill', 'heuristic', 'negative', 'fact', 'tool_proposal')),
  title           text NOT NULL,
  scope           text NOT NULL,              -- модуль/glob/'all'; определяет широту (G4)
  tags            text[] NOT NULL DEFAULT '{}',
  applies_to      text NOT NULL DEFAULT 'all', -- 'all' | agent/model id (ТЗ §14.2)
  status          text NOT NULL DEFAULT 'candidate'
                  CHECK (status IN ('candidate', 'queued', 'canary', 'active', 'deprecated', 'archived')),
  risk_tier       text NOT NULL DEFAULT 'low' CHECK (risk_tier IN ('low', 'high')),
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  body            text NOT NULL,              -- тело текущей версии
  body_hash       text NOT NULL,              -- sha256(body)
  embedding_id    text,                       -- ссылка на pgvector (M2), NULL до индесации
  score_global    real NOT NULL DEFAULT 0 CHECK (score_global >= 0 AND score_global <= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_reason text                         -- обязателен при status='archived'
);

-- ТЗ §7.2.1: archived всегда с причиной + авто-обновление updated_at.
CREATE OR REPLACE FUNCTION items_before_update() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'archived' AND (NEW.archived_reason IS NULL OR NEW.archived_reason = '') THEN
    RAISE EXCEPTION 'items: переход в archived без archived_reason (ТЗ §7.2.1)';
  END IF;
  IF NEW.status = 'archived' AND OLD.archived_reason IS NOT NULL THEN
    NEW.archived_reason := OLD.archived_reason; -- причина immutable
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER items_before_update_trigger
BEFORE UPDATE ON items
FOR EACH ROW EXECUTE FUNCTION items_before_update();

CREATE INDEX items_status_idx      ON items (status);
CREATE INDEX items_type_idx        ON items (type);
CREATE INDEX items_scope_idx       ON items (scope);
CREATE INDEX items_applies_to_idx  ON items (applies_to);
-- FTS-канал retrieval (ТЗ §10.1): keyword-канал на идентификаторах/пути.
CREATE INDEX items_body_fts_idx ON items USING gin (to_tsvector('simple', body));

-- ----------------------------------------------------------------------------
-- item_versions — иммутабельная история (ТЗ §7.2.2)
-- ----------------------------------------------------------------------------
CREATE TABLE item_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  version         integer NOT NULL CHECK (version >= 1),
  body            text NOT NULL,
  body_hash       text NOT NULL,
  embedding_id    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  superseded_by   uuid REFERENCES item_versions (id),
  UNIQUE (item_id, version)
);

CREATE INDEX item_versions_item_idx ON item_versions (item_id);
-- ТЗ §7.2.5: старые версии остаются searchable для аудита.
CREATE INDEX item_versions_body_fts_idx ON item_versions USING gin (to_tsvector('simple', body));

-- ----------------------------------------------------------------------------
-- provenance — привязка к источнику (ТЗ §6, §7.2.7 обратимость сжатия)
-- ----------------------------------------------------------------------------
CREATE TABLE provenance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  version         integer NOT NULL CHECK (version >= 1),
  source_type     text NOT NULL CHECK (source_type IN ('success', 'review', 'critic', 'human')),
  task_id         text NOT NULL,
  transcript_hash text NOT NULL,
  commit          text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- верификатор, rating, issues (ТЗ §11.1)
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provenance_item_idx   ON provenance (item_id);
CREATE INDEX provenance_task_idx   ON provenance (task_id);
CREATE INDEX provenance_commit_idx ON provenance (commit);

-- ----------------------------------------------------------------------------
-- usage_log — факты использования (запись ДО начала задачи, ТЗ §10.3)
-- ----------------------------------------------------------------------------
CREATE TABLE usage_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  version         integer NOT NULL CHECK (version >= 1),
  agent_id        text NOT NULL,
  task_id         text NOT NULL,
  task_success    boolean,                     -- заполняется верификатором позже
  retrieved_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_log_item_idx     ON usage_log (item_id);
CREATE INDEX usage_log_agent_idx    ON usage_log (agent_id);
CREATE INDEX usage_log_task_idx     ON usage_log (task_id);

-- ----------------------------------------------------------------------------
-- decisions — кто/почему/доказательство (ТЗ §7.2.3, §12.1)
-- ----------------------------------------------------------------------------
CREATE TABLE decisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  version    integer NOT NULL CHECK (version >= 1),
  kind       text NOT NULL
             CHECK (kind IN ('promote', 'reject', 'demote', 'merge', 'archive', 'approve_edit', 'rollback')),
  actor      text NOT NULL,                    -- 'auto:<gate>' | 'auto:canary' | 'auto:degradation' | 'human'
  reason     text NOT NULL,
  evidence   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decisions_item_idx    ON decisions (item_id);
CREATE INDEX decisions_actor_idx   ON decisions (actor);
CREATE INDEX decisions_created_idx ON decisions (created_at);

-- ----------------------------------------------------------------------------
-- gate_results — результаты гейтов (ТЗ §7.1, конвейер §9)
-- ----------------------------------------------------------------------------
CREATE TABLE gate_results (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id text NOT NULL,                  -- id кандидата (до превращения в item)
  gate         text NOT NULL CHECK (gate IN ('evidence', 'dedup', 'conflict', 'scope', 'budget')),
  result       text NOT NULL CHECK (result IN ('pass', 'fail', 'skip')),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- merge_item_id, contradiction_id, лимиты…
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gate_results_candidate_idx ON gate_results (candidate_id);
CREATE INDEX gate_results_gate_idx      ON gate_results (gate);
-- G5: дневной лимит на агента — по detail.agent_id + дате.
CREATE INDEX gate_results_detail_agent_idx ON gate_results ((detail->>'agent_id'));

-- ----------------------------------------------------------------------------
-- contradictions (ТЗ §7.1)
-- ----------------------------------------------------------------------------
CREATE TABLE contradictions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_a_id    uuid NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_b_id    uuid NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  severity     text NOT NULL CHECK (severity IN ('low', 'med', 'high')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  CHECK (item_a_id <> item_b_id)
);

CREATE INDEX contradictions_status_idx ON contradictions (status);

-- ----------------------------------------------------------------------------
-- agent_profiles (ТЗ §7.1, §10.2, §14: agent-agnostic)
-- ----------------------------------------------------------------------------
CREATE TABLE agent_profiles (
  agent_id        text PRIMARY KEY,
  context_budget  integer NOT NULL CHECK (context_budget > 0),   -- бюджет токенов контекст-блока
  retrieval_top_k integer NOT NULL CHECK (retrieval_top_k > 0),
  format          text NOT NULL CHECK (format IN ('markdown', 'json', 'tool_call')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- pgvector-таблица (M2): embedding на ВЕРСИЮ (ТЗ §7.2.5).
-- Источник правды — SQL; vector — только индекс (ТЗ §5).
-- ----------------------------------------------------------------------------
CREATE TABLE embeddings (
  embedding_id  text PRIMARY KEY,
  item_id       uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version >= 1),
  vector        vector(1536) NOT NULL,        -- размерность = модель M1/M2
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, version)
);

-- HNSW-индекс строится после наполнения (M2):
-- CREATE INDEX embeddings_vec_idx ON embeddings USING hnsw (vector vector_cosine_ops);
