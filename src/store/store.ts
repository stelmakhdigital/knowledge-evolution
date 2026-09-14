import type {
  AgentProfile,
  Contradiction,
  Decision,
  DecisionKind,
  GateName,
  GateResult,
  Item,
  ItemStatus,
  ItemType,
  ItemVersion,
  Provenance,
  UsageLogEntry,
} from "../domain/types.js";

/**
 * Контракт хранилища (ТЗ §7.1). M0 — in-memory; M2 — Postgres (источник правды — SQL).
 * Инварианты (ТЗ §7.2, §8):
 *  - жёсткого DELETE нет: только archived + archived_reason;
 *  - тело версии иммутабельно: изменение — новая версия + decision approve_edit;
 *  - каждое изменение статуса — запись в decisions;
 *  - единственный путь создания item — кандидат + гейты (старт всегда в candidate).
 */
export interface TransitionInput {
  readonly to: ItemStatus;
  readonly kind: DecisionKind;
  readonly actor: string; // 'auto:<gate>' | 'human'
  readonly reason: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly archivedReason?: string; // только для to='archived'
}

export interface CreateItemInput {
  readonly item: Item;
  readonly provenance: readonly Provenance[];
  /** Decision о создании (прохождение гейтов): actor='auto:gate' | 'human'; id/createdAt — в store. */
  readonly initialDecision: Omit<Decision, "id" | "createdAt">;
}

export interface Store {
  // --- items ---
  /** Создаёт item (обязательно status='candidate') + провенанс + decision. */
  addItem(input: CreateItemInput): void;
  getItem(id: string): Item | null;
  listItems(filter?: { status?: ItemStatus; type?: ItemType }): readonly Item[];
  /**
   * Применяет смену статуса: проверяет стейт-машину, пишет decision, возвращает
   * обновлённый item. Недействительный переход — InvalidTransitionError.
   */
  applyTransition(itemId: string, input: TransitionInput): Item;

  // --- версии (иммутабельная история) ---
  /** Новая версия тела (kind обязан быть 'approve_edit') + decision. */
  addVersion(itemId: string, body: string, decision: Omit<Decision, "id" | "itemId" | "version" | "createdAt">): Item;
  itemVersions(itemId: string): readonly ItemVersion[];

  // --- провенанс (white-box drill-down, ТЗ §7.2.6) ---
  provenanceFor(itemId: string): readonly Provenance[];

  // --- гейты ---
  addGateResult(gateResult: GateResult): void;
  gateResultsFor(candidateId: string): readonly GateResult[];
  /** Поисковый доступ (G5-лимиты): по гейту, дате и agent_id из detail. */
  listGateResults(filter?: { gate?: GateName; since?: string; agentId?: string }): readonly GateResult[];

  // --- решения (аудит) ---
  decisionsFor(itemId: string): readonly Decision[];

  // --- телеметрия (M2, контракт готов заранее) ---
  addUsage(entry: UsageLogEntry): void;
  usageFor(itemId: string): readonly UsageLogEntry[];

  // --- противоречия ---
  addContradiction(contradiction: Contradiction): void;
  listContradictions(filter?: { status?: "open" | "resolved" }): readonly Contradiction[];
  resolveContradiction(id: string, resolvedBy: string): void;

  // --- профили агентов (agent-agnostic, ТЗ §14) ---
  getAgentProfile(agentId: string): AgentProfile | null;
  upsertAgentProfile(profile: AgentProfile): void;
}
