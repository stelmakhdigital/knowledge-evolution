/**
 * Доменные типы базы знания (ТЗ §7–§8, §11, §13, §14).
 * Агент-агностично: конкретный агент — это agent_id + профиль (ТЗ §14).
 */

// --- Типы знания (ТЗ §8) ---

export const ITEM_TYPES = ["skill", "heuristic", "negative", "fact", "tool_proposal"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Типы, которые ВСЕГДА high risk (ТЗ §8: negative, tool_proposal). */
export const ALWAYS_HIGH_RISK_TYPES: ReadonlySet<ItemType> = new Set(["negative", "tool_proposal"]);

// --- Статусы (ТЗ §7.1: items.status) ---

export const ITEM_STATUSES = ["candidate", "queued", "canary", "active", "deprecated", "archived"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const RISK_TIERS = ["low", "high"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

// --- Решения (ТЗ §7.1: decisions; rollback — «вернуть» из недельного окна, §12.1) ---

export const DECISION_KINDS = [
  "promote",
  "reject",
  "demote",
  "merge",
  "archive",
  "approve_edit",
  "rollback",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

// --- Провенанс (ТЗ §7.1: provenance) ---

export const PROVENANCE_SOURCE_TYPES = ["success", "review", "critic", "human"] as const;
export type ProvenanceSourceType = (typeof PROVENANCE_SOURCE_TYPES)[number];

// --- Гейты (ТЗ §7.1: gate_results; конвейер §9) ---

export const GATE_NAMES = ["evidence", "dedup", "conflict", "scope", "budget"] as const;
export type GateName = (typeof GATE_NAMES)[number];

export const GATE_OUTCOMES = ["pass", "fail", "skip"] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

// --- Прочее ---

export const VERIFIERS = ["tests", "lint", "smoke", "human"] as const;
export type Verifier = (typeof VERIFIERS)[number];

/** Иммутабельная запись провенанса: привязка к источнику (ТЗ §6). */
export interface Provenance {
  sourceType: ProvenanceSourceType;
  taskId: string;
  transcriptHash: string;
  commit: string;
  payload: Readonly<Record<string, unknown>>;
  createdAt: string; // ISO-8601
}

/** Версируемый элемент базы (ТЗ §7.1: items). */
export interface Item {
  id: string;
  type: ItemType;
  title: string;
  scope: string; // модуль/glob/«all»; определяет широту (G4)
  tags: readonly string[];
  appliesTo: string; // 'all' | agent/model id (ТЗ §14.2, default 'all')
  status: ItemStatus;
  riskTier: RiskTier; // вычисляется гейтами
  version: number;
  body: string; // тело текущей версии
  bodyHash: string;
  embeddingId: string | null; // ссылка на индекс (pgvector), M2
  scoreGlobal: number; // агрегированный; пересчёт из usage_log (ТЗ §7.2.4)
  createdAt: string;
  updatedAt: string;
  archivedReason?: string; // заполняется при status='archived'
}

/** Иммутабельная история версий (ТЗ §7.1: item_versions). */
export interface ItemVersion {
  id: string;
  itemId: string;
  version: number;
  body: string;
  bodyHash: string;
  embeddingId: string | null;
  createdAt: string;
  supersededBy: string | null;
}

/** Каждое изменение статуса — запись в decisions (ТЗ §7.2.3). */
export interface Decision {
  id: string;
  itemId: string;
  version: number;
  kind: DecisionKind;
  actor: string; // 'auto:<gate>' | 'human' | 'auto:canary' | 'auto:degradation'
  reason: string;
  evidence: Readonly<Record<string, unknown>>;
  createdAt: string;
}

/** Результат гейта (ТЗ §7.1: gate_results). */
export interface GateResult {
  id: string;
  candidateId: string;
  gate: GateName;
  outcome: GateOutcome;
  detail: Readonly<Record<string, unknown>>;
  createdAt: string;
}

/** Структурированный кандидат до прохождения гейтов (ТЗ §8: единственный путь — кандидат + гейты). */
export interface Candidate {
  type: ItemType;
  title: string;
  scope: string;
  tags: readonly string[];
  appliesTo: string;
  body: string;
  provenance: Provenance;
}

/** Факт использования: запись ДО начала задачи (ТЗ §10.3). */
export interface UsageLogEntry {
  id: string;
  itemId: string;
  version: number;
  agentId: string;
  taskId: string;
  taskSuccess: boolean | null; // заполняется верификатором позже
  retrievedAt: string;
}

/** Противоречие между элементами (ТЗ §7.1: contradictions). */
export interface Contradiction {
  id: string;
  itemAId: string;
  itemBId: string;
  severity: "low" | "med" | "high";
  status: "open" | "resolved";
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt?: string;
}

/** Профиль агента (ТЗ §7.1: agent_profiles, §10.2 адаптер). */
export interface AgentProfile {
  agentId: string;
  contextBudget: number; // бюджет токенов контекст-блока
  retrievalTopK: number;
  format: "markdown" | "json" | "tool_call";
  createdAt: string;
}

/** Событие верификации (ТЗ §11.1, §11.4: verifier_id + human_override). */
export interface TaskVerified {
  taskId: string;
  agentId: string;
  success: boolean;
  verifier: Verifier;
  verifierId: string;
  humanOverride?: boolean;
  recordedAt: string;
}

/** Детерминированное время: инъекция вместо Date.now() (правило тестов). */
export type Clock = () => Date;
