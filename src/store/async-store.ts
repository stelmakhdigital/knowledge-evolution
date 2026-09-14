import type {
  AgentProfile,
  Contradiction,
  Decision,
  GateName,
  GateResult,
  Item,
  ItemStatus,
  ItemType,
  ItemVersion,
  Provenance,
  UsageLogEntry,
} from "../domain/types.js";
import type { TelemetryEvent } from "../domain/telemetry.js";
import type { CreateItemInput, Store, TransitionInput } from "./store.js";

/**
 * Асинхронная версия контракта хранилища (M2: Postgres — источник правды, ТЗ §5/§7.1).
 * Синхронный `Store` (MemoryStore) остаётся для тестов/dev; приложение переходит
 * на AsyncStore в M2.2/M2.4 (retrieval-сервис и end-to-end).
 * Инварианты те же, что у Store (ТЗ §7.2, §8).
 */
export interface AsyncStore {
  addItem(input: CreateItemInput): Promise<void>;
  getItem(id: string): Promise<Item | null>;
  listItems(filter?: { status?: ItemStatus; type?: ItemType }): Promise<readonly Item[]>;
  applyTransition(itemId: string, input: TransitionInput): Promise<Item>;
  addVersion(itemId: string, body: string, decision: Omit<Decision, "id" | "itemId" | "version" | "createdAt">): Promise<Item>;
  /** Идемпотентный тег (M5.2: transfer:weak и др.). */
  addTag(itemId: string, tag: string): Promise<void>;
  itemVersions(itemId: string): Promise<readonly ItemVersion[]>;
  provenanceFor(itemId: string): Promise<readonly Provenance[]>;
  addGateResult(gateResult: GateResult): Promise<void>;
  gateResultsFor(candidateId: string): Promise<readonly GateResult[]>;
  listGateResults(filter?: { gate?: GateName; since?: string; agentId?: string }): Promise<readonly GateResult[]>;
  decisionsFor(itemId: string): Promise<readonly Decision[]>;
  addUsage(entry: UsageLogEntry): Promise<void>;
  usageFor(itemId: string): Promise<readonly UsageLogEntry[]>;
  usageForTask(taskId: string): Promise<readonly UsageLogEntry[]>;
  addEvent(event: TelemetryEvent): Promise<void>;
  listEvents(filter?: { taskId?: string }): Promise<readonly TelemetryEvent[]>;
  backfillUsageForTask(taskId: string, success: boolean): Promise<{ updated: number; unchanged: number }>;
  addContradiction(contradiction: Contradiction): Promise<void>;
  listContradictions(filter?: { status?: "open" | "resolved" }): Promise<readonly Contradiction[]>;
  resolveContradiction(id: string, resolvedBy: string): Promise<void>;
  getAgentProfile(agentId: string): Promise<AgentProfile | null>;
  upsertAgentProfile(profile: AgentProfile): Promise<void>;
}

/** Обёртка: синхронный Store (MemoryStore) → AsyncStore (для общих контракт-тестов). */
export function asyncStoreOf(sync: Store): AsyncStore {
  const p = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(fn); // синхронный throw → rejected
  return {
    addItem: (input) => p(() => { sync.addItem(input); }),
    getItem: (id) => p(() => sync.getItem(id)),
    listItems: (filter) => p(() => sync.listItems(filter)),
    applyTransition: (itemId, input) => p(() => sync.applyTransition(itemId, input)),
    addVersion: (itemId, body, decision) => p(() => sync.addVersion(itemId, body, decision)),
    addTag: (itemId, tag) => p(() => { sync.addTag(itemId, tag); }),
    itemVersions: (itemId) => p(() => sync.itemVersions(itemId)),
    provenanceFor: (itemId) => p(() => sync.provenanceFor(itemId)),
    addGateResult: (gr) => p(() => { sync.addGateResult(gr); }),
    gateResultsFor: (candidateId) => p(() => sync.gateResultsFor(candidateId)),
    listGateResults: (filter) => p(() => sync.listGateResults(filter)),
    decisionsFor: (itemId) => p(() => sync.decisionsFor(itemId)),
    addUsage: (entry) => p(() => { sync.addUsage(entry); }),
    usageFor: (itemId) => p(() => sync.usageFor(itemId)),
    usageForTask: (taskId) => p(() => sync.usageForTask(taskId)),
    addEvent: (event) => p(() => { sync.addEvent(event); }),
    listEvents: (filter) => p(() => sync.listEvents(filter)),
    backfillUsageForTask: (taskId, success) => p(() => sync.backfillUsageForTask(taskId, success)),
    addContradiction: (c) => p(() => { sync.addContradiction(c); }),
    listContradictions: (filter) => p(() => sync.listContradictions(filter)),
    resolveContradiction: (id, resolvedBy) => p(() => { sync.resolveContradiction(id, resolvedBy); }),
    getAgentProfile: (agentId) => p(() => sync.getAgentProfile(agentId)),
    upsertAgentProfile: (profile) => p(() => { sync.upsertAgentProfile(profile); }),
  };
}
