import type { EvolveConfig } from "../config/config.js";
import type { Contradiction, GateResult, Item, Provenance } from "../domain/types.js";
import type { Store } from "../store/store.js";

/**
 * Карточка high-risk кандидата в очереди (ТЗ §12.1):
 * провенанс (задачи/коммиты), «цена бездействия», противоречия, возраст карточки.
 * М1-приближения (задокументированы):
 *  - daysInQueue ≈ от последнего изменения item (момент перехода в queued);
 *  - costOfInaction ≈ число элементов с пересекающимися тегами (сколько задач/знаний
 *    затронуты той же категорией проблемы).
 */

export interface QueueCard {
  readonly item: Item;
  /** Дней в очереди (приближение, см. модуль). */
  readonly daysInQueue: number;
  /** true, если карточка старше alerts.queue_card_max_days (алерт «очередь гниёт», ТЗ §12.2). */
  readonly stale: boolean;
  /** Цена бездействия (М1-приближение). */
  readonly costOfInaction: number;
  readonly provenanceRefs: readonly Provenance[];
  readonly openContradictions: readonly Contradiction[];
  readonly gateResults: readonly GateResult[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildQueueCard(
  item: Item,
  store: Store,
  config: EvolveConfig,
  now: Date,
): QueueCard {
  const provenanceRefs = store.provenanceFor(item.id);
  // candidate_ref из evidence первого decision → gate_results кандидата.
  const candidateRef = store.decisionsFor(item.id)[0]?.evidence["candidate_ref"];
  const gateResults =
    typeof candidateRef === "string" ? store.gateResultsFor(candidateRef) : [];
  const openContradictions = store
    .listContradictions({ status: "open" })
    .filter((c) => c.itemAId === item.id || c.itemBId === item.id);

  const daysInQueue = Math.max(
    0,
    Math.floor((now.getTime() - new Date(item.updatedAt).getTime()) / DAY_MS),
  );
  const stale = daysInQueue > config.alerts.queue_card_max_days;

  // Цена бездействия: другие неархивированные элементы с общим тегом (≥1) + сам элемент.
  const tags = new Set(item.tags);
  let cost = 1;
  for (const other of store.listItems()) {
    if (other.id === item.id || other.status === "archived") {
      continue;
    }
    if (other.tags.some((t) => tags.has(t))) {
      cost += 1;
    }
  }

  return {
    item,
    daysInQueue,
    stale,
    costOfInaction: cost,
    provenanceRefs,
    openContradictions,
    gateResults,
  };
}

/** Список карточек очереди: по цене бездействия (убыв), затем старейшие первыми. */
export function listQueueCards(
  store: Store,
  config: EvolveConfig,
  now: Date,
): readonly QueueCard[] {
  return store
    .listItems({ status: "queued" })
    .map((item) => buildQueueCard(item, store, config, now))
    .sort(
      (a, b) =>
        b.costOfInaction - a.costOfInaction ||
        a.item.updatedAt.localeCompare(b.item.updatedAt),
    );
}
