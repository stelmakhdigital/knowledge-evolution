import { randomUUID } from "node:crypto";
import { hashBody } from "../domain/hashing.js";
import { InvariantViolationError, NotFoundError } from "../domain/errors.js";
import { checkTransition } from "../domain/state-machine.js";
import type {
  AgentProfile,
  Clock,
  Contradiction,
  Decision,
  GateName,
  GateResult,
  Item,
  ItemType,
  ItemStatus,
  ItemVersion,
  Provenance,
  UsageLogEntry,
} from "../domain/types.js";
import type { CreateItemInput, Store, StoreSnapshot, TransitionInput } from "./store.js";

/**
 * In-memory хранилище (M0). Детерминированность: время — через инъекцию Clock,
 * id — crypto.randomUUID. Postgres-реализация по этому же контракту — M2.
 */
export class MemoryStore implements Store {
  private readonly clock: Clock;
  private readonly items = new Map<string, Item>();
  private readonly versions = new Map<string, ItemVersion[]>();
  private readonly provenance = new Map<string, Provenance[]>();
  private readonly decisions = new Map<string, Decision[]>();
  private readonly gateResults = new Map<string, GateResult[]>();
  private readonly usage = new Map<string, UsageLogEntry[]>();
  private readonly contradictions: Contradiction[] = [];
  private readonly profiles = new Map<string, AgentProfile>();

  constructor(clock: Clock = () => new Date(), snapshot?: StoreSnapshot) {
    this.clock = clock;
    if (snapshot) {
      // Поля могут отсутствовать (обрезанный файл) — нормализуем к пустым коллекциям.
      const items = snapshot.items ?? [];
      const versions = snapshot.versions ?? {};
      const provenance = snapshot.provenance ?? {};
      const decisions = snapshot.decisions ?? {};
      const gateResults = snapshot.gateResults ?? {};
      const usage = snapshot.usage ?? {};
      const contradictions = snapshot.contradictions ?? [];
      const profiles = snapshot.profiles ?? {};
      this.items = new Map(items.map((i) => [i.id, { ...i }]));
      this.versions = new Map(Object.entries(versions).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
      this.provenance = new Map(Object.entries(provenance).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
      this.decisions = new Map(Object.entries(decisions).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
      this.gateResults = new Map(
        Object.entries(gateResults).map(([k, v]) => [
          k,
          v.map((x) => ({ ...x, detail: { ...x.detail } })),
        ]),
      );
      this.usage = new Map(Object.entries(usage).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
      this.contradictions = contradictions.map((c) => ({ ...c }));
      this.profiles = new Map(Object.entries(profiles).map(([k, v]) => [k, { ...v }]));
    }
  }

  // --- items ---

  addItem(input: CreateItemInput): void {
    const { item, provenance, initialDecision } = input;
    if (this.items.has(item.id)) {
      throw new InvariantViolationError("DUPLICATE_ITEM", `item ${item.id} уже существует`);
    }
    if (item.status !== "candidate") {
      // ТЗ §8: единственный путь создания — кандидат + гейты; прямая запись в active запрещена.
      throw new InvariantViolationError(
        "INVALID_ITEM_CREATION",
        `item обязан создаваться со status='candidate' (ТЗ §8), передано '${item.status}'`,
      );
    }
    if (item.bodyHash !== hashBody(item.body)) {
      throw new InvariantViolationError("BODY_HASH_MISMATCH", `body_hash не соответствует body у item ${item.id}`);
    }
    const now = this.now();
    this.items.set(item.id, { ...item, tags: [...item.tags] });
    this.versions.set(item.id, [{
      id: randomUUID(),
      itemId: item.id,
      version: item.version,
      body: item.body,
      bodyHash: item.bodyHash,
      embeddingId: item.embeddingId,
      createdAt: now,
      supersededBy: null,
    }]);
    this.provenance.set(item.id, [...provenance]);
    this.decisions.set(item.id, [{ ...initialDecision, id: randomUUID(), createdAt: now }]);
  }

  getItem(id: string): Item | null {
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  listItems(filter?: { status?: ItemStatus; type?: ItemType }): readonly Item[] {
    return [...this.items.values()]
      .filter((i) => (!filter?.status || i.status === filter.status) && (!filter?.type || i.type === filter.type))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((i) => ({ ...i }));
  }

  applyTransition(itemId: string, input: TransitionInput): Item {
    const item = this.items.get(itemId);
    if (!item) {
      throw new NotFoundError(`item ${itemId} не найден`);
    }
    if (input.to === "archived" && !input.archivedReason) {
      throw new InvariantViolationError("ARCHIVE_REASON_REQUIRED", "переход в archived требует archived_reason (ТЗ §7.2.1)");
    }
    checkTransition({ from: item.status, to: input.to, kind: input.kind, actor: input.actor });
    const decision = this.recordDecision(itemId, item.version, input.kind, input.actor, input.reason, input.evidence);
    item.status = input.to;
    item.updatedAt = decision.createdAt;
    if (input.to === "archived" && input.archivedReason) {
      item.archivedReason = input.archivedReason;
    }
    return { ...item };
  }

  // --- версии ---

  addVersion(
    itemId: string,
    body: string,
    decision: Omit<Decision, "id" | "itemId" | "version" | "createdAt">,
  ): Item {
    if (decision.kind !== "approve_edit") {
      throw new InvariantViolationError("INVALID_DECISION_KIND", "новая версия тела требует kind='approve_edit' (ТЗ §12.1 «принять с правкой»)");
    }
    const item = this.items.get(itemId);
    if (!item) {
      throw new NotFoundError(`item ${itemId} не найден`);
    }
    const versions = this.versions.get(itemId) ?? [];
    const current = versions.at(-1);
    const now = this.now();
    const next: ItemVersion = {
      id: randomUUID(),
      itemId,
      version: item.version + 1,
      body,
      bodyHash: hashBody(body),
      embeddingId: null,
      createdAt: now,
      supersededBy: null,
    };
    if (current) {
      current.supersededBy = next.id; // тело версии иммутабельно: старая остаётся, ссылающаяся связь — новая (ТЗ §7.2.2)
    }
    versions.push(next);
    item.version = next.version;
    item.body = next.body;
    item.bodyHash = next.bodyHash;
    item.updatedAt = now;
    this.recordDecision(itemId, next.version, "approve_edit", decision.actor, decision.reason, decision.evidence);
    return { ...item };
  }

  itemVersions(itemId: string): readonly ItemVersion[] {
    return (this.versions.get(itemId) ?? []).map((v) => ({ ...v }));
  }

  // --- провенанс ---

  provenanceFor(itemId: string): readonly Provenance[] {
    return (this.provenance.get(itemId) ?? []).map((p) => ({ ...p }));
  }

  // --- гейты ---

  addGateResult(gateResult: GateResult): void {
    const list = this.gateResults.get(gateResult.candidateId) ?? [];
    list.push({ ...gateResult, detail: { ...gateResult.detail } });
    this.gateResults.set(gateResult.candidateId, list);
  }

  gateResultsFor(candidateId: string): readonly GateResult[] {
    return (this.gateResults.get(candidateId) ?? []).map((g) => ({ ...g, detail: { ...g.detail } }));
  }

  listGateResults(filter?: { gate?: GateName; since?: string; agentId?: string }): readonly GateResult[] {
    return [...this.gateResults.values()]
      .flat()
      .filter((g) => {
        if (filter?.gate && g.gate !== filter.gate) {
          return false;
        }
        if (filter?.since && g.createdAt < filter.since) {
          return false;
        }
        if (filter?.agentId && g.detail["agent_id"] !== filter.agentId) {
          return false;
        }
        return true;
      })
      .map((g) => ({ ...g, detail: { ...g.detail } }));
  }

  // --- решения ---

  decisionsFor(itemId: string): readonly Decision[] {
    return (this.decisions.get(itemId) ?? []).map((d) => ({ ...d, evidence: { ...d.evidence } }));
  }

  // --- телеметрия ---

  addUsage(entry: UsageLogEntry): void {
    const list = this.usage.get(entry.itemId) ?? [];
    list.push({ ...entry });
    this.usage.set(entry.itemId, list);
  }

  usageFor(itemId: string): readonly UsageLogEntry[] {
    return (this.usage.get(itemId) ?? []).map((u) => ({ ...u }));
  }

  // --- противоречия ---

  addContradiction(contradiction: Contradiction): void {
    this.contradictions.push({ ...contradiction });
  }

  listContradictions(filter?: { status?: "open" | "resolved" }): readonly Contradiction[] {
    return this.contradictions
      .filter((c) => !filter?.status || c.status === filter.status)
      .map((c) => ({ ...c }));
  }

  resolveContradiction(id: string, resolvedBy: string): void {
    const c = this.contradictions.find((x) => x.id === id);
    if (!c) {
      throw new NotFoundError(`contradiction ${id} не найдена`);
    }
    if (c.status === "resolved") {
      throw new InvariantViolationError("ALREADY_RESOLVED", `contradiction ${id} уже решена (${c.resolvedBy})`);
    }
    c.status = "resolved";
    c.resolvedBy = resolvedBy;
    c.resolvedAt = this.now();
  }

  // --- профили агентов ---

  getAgentProfile(agentId: string): AgentProfile | null {
    const p = this.profiles.get(agentId);
    return p ? { ...p } : null;
  }

  upsertAgentProfile(profile: AgentProfile): void {
    this.profiles.set(profile.agentId, { ...profile });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  // --- сериализация (CLI: состояние между вызовами, M0; Postgres — M2) ---

  /** Плоский JSON-снимок всего состояния. */
  snapshot(): StoreSnapshot {
    const byKey = <T,>(map: Map<string, T[]>): Record<string, T[]> =>
      Object.fromEntries([...map.entries()].map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
    return {
      items: [...this.items.values()].map((i) => ({ ...i })),
      versions: byKey(this.versions),
      provenance: byKey(this.provenance),
      decisions: byKey(this.decisions),
      gateResults: byKey(this.gateResults),
      usage: byKey(this.usage),
      contradictions: this.contradictions.map((c) => ({ ...c })),
      profiles: Object.fromEntries([...this.profiles.entries()].map(([k, v]) => [k, { ...v }])),
    };
  }

  /** Восстановление из снапшота (инварианты перепроверяются при мутациях, не при загрузке). */
  static fromSnapshot(snapshot: StoreSnapshot, clock: Clock = () => new Date()): MemoryStore {
    return new MemoryStore(clock, snapshot);
  }

  private recordDecision(
    itemId: string,
    version: number,
    kind: Decision["kind"],
    actor: string,
    reason: string,
    evidence: Readonly<Record<string, unknown>> | undefined,
  ): Decision {
    const decision: Decision = {
      id: randomUUID(),
      itemId,
      version,
      kind,
      actor,
      reason,
      evidence: evidence ? { ...evidence } : {},
      createdAt: this.now(),
    };
    const list = this.decisions.get(itemId) ?? [];
    list.push(decision);
    this.decisions.set(itemId, list);
    return decision;
  }
}
