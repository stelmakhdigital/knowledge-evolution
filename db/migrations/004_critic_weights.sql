-- M4 (ТЗ §13/§15 M4): авто-вес критика. Вес = производная от телеметрии
-- (gate pass-rate lesson-кандидатов + usage-фактор), пересчёт еженедельный
-- и идемпотентный; «ложные issues снижают вес механически».
CREATE TABLE IF NOT EXISTS critic_weights (
  source_id      text PRIMARY KEY,        -- 'critic' (позже — id отдельных критик-агентов)
  weight         real NOT NULL CHECK (weight > 0),
  gate_pass_rate real,                    -- NULL — нет lesson-кандидатов
  usage_factor   real NOT NULL DEFAULT 1,
  lessons        integer NOT NULL DEFAULT 0 CHECK (lessons >= 0),
  accepted       integer NOT NULL DEFAULT 0 CHECK (accepted >= 0),
  computed_at    timestamptz NOT NULL DEFAULT now()
);
