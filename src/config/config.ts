import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Ошибка конфигурации: машиночитаемый code + человекочитаемое сообщение (ts-rules: ошибки). */
export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

const weight = z.number().min(0).max(1);

/** Схема единого конфига (ТЗ §5). Внешний YAML — unknown, сужается только здесь. */
export const evolveConfigSchema = z.object({
  version: z.literal(1),
  theta_dedup: weight,
  canary_epsilon: weight,
  theta_score: weight,
  canary: z.object({
    window_days: z.number().int().positive(),
    min_retrievals: z.number().int().positive(),
    cost_multiplier_max: z.number().positive(),
  }),
  degradation: z.object({
    min_usage_for_demote: z.number().int().positive(),
    unused_days: z.number().int().positive(),
    deprecated_to_archived_days: z.number().int().positive(),
    max_deprecated_share_per_month: z.number().min(0).max(1),
    open_contradiction_days: z.number().int().positive(),
  }),
  budget: z.object({
    active_max: z.number().int().positive(),
    queue_per_week_max: z.number().int().positive(),
    candidates_per_agent_per_day_max: z.number().int().positive(),
  }),
  alerts: z.object({
    active_budget_ratio: weight,
    open_contradictions_max: z.number().int().positive(),
    success_rate_drop: weight,
    churn_demos_per_week_max: z.number().int().positive(),
    queue_card_max_days: z.number().int().positive(),
    cost_growth: weight,
  }),
  retrieval: z.object({
    mode: z.enum(["hybrid", "keyword", "embedding"]),
    top_k: z.number().int().positive(),
    rrf_k: z.number().int().positive(),
    weights: z.object({
      rrf_rank: z.number().nonnegative(),
      item_score: z.number().nonnegative(),
      scope_match: z.number().nonnegative(),
      recency_decay: z.number().nonnegative(),
    }),
    budget: z.object({
      max_chars_per_item: z.number().int().nonnegative(),
      max_total_recall_chars: z.number().int().nonnegative(),
      timeout_ms: z.number().int().positive(),
    }),
  }),
  score: z.object({
    success_rate_weight: weight,
    usage_norm_weight: weight,
    recency_weight: weight,
    min_used: z.number().int().positive(),
  }),
  critic: z.object({
    weight: z.number().nonnegative(),
  }),
  /** Ablation-флаги (ТЗ §12.4): каждый модуль поддерживает режим off на неделю. */
  ablation: z
    .object({
      dedup: z.boolean().default(true),
      conflict: z.boolean().default(true),
      canary: z.boolean().default(true),
      critic: z.boolean().default(true),
      negative: z.boolean().default(true),
    })
    .default({ dedup: true, conflict: true, canary: true, critic: true, negative: true }),
});

export type EvolveConfig = z.infer<typeof evolveConfigSchema>;

/** Путь к конфигу: $EVOLVE_CONFIG, иначе ./config.yaml. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["EVOLVE_CONFIG"];
  return fromEnv && fromEnv.length > 0 ? fromEnv : "config.yaml";
}

/** Читает и валидирует YAML-конфиг. Любое отклонение — ConfigError (CLI ловит на границе). */
export function loadConfig(path: string): EvolveConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError("CONFIG_NOT_FOUND", `не удалось прочитать конфиг ${path}: ${detail}`);
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError("CONFIG_INVALID", `конфиг ${path}: YAML не распарсился: ${detail}`);
  }

  const parsed = evolveConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `конфиг ${path}: схема нарушена: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<корень>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
