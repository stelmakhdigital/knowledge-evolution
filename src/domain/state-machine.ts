import { InvalidTransitionError } from "./errors.js";
import type { DecisionKind, ItemStatus } from "./types.js";

/**
 * Стейт-машина статусов (ТЗ §9, §12.1).
 * Каждое ребро фиксирует: какой kind решения требуется и для каких классов
 * actor'а разрешён переход. Любое нарушение — InvalidTransitionError.
 *
 * Картинка (из ТЗ §9):
 *   candidate ──low──▶ canary ──pass──▶ active
 *   candidate ──high─▶ queued ─human─▶ canary
 *   canary ──fail──▶ candidate (повтор — только новым кандидатом)
 *   active ──деградация/drift──▶ deprecated | queued (широкий scope)
 *   deprecated ──30д / восстановление──▶ archived | active
 *   archived — терминальное (жёсткого DELETE нет, ТЗ §7.2.1)
 */

export type ActorClass = "auto" | "human";

export interface TransitionEdge {
  readonly to: ItemStatus;
  readonly kind: DecisionKind;
  readonly actors: readonly ActorClass[];
}

/** Класс actor'а из строки: 'human' | 'auto:<gate>' → 'auto' | 'human'. */
export function actorClassOf(actor: string): ActorClass {
  return actor.startsWith("auto:") ? "auto" : "human";
}

export const STATE_MACHINE: Readonly<Record<ItemStatus, readonly TransitionEdge[]>> = {
  candidate: [
    { to: "canary", kind: "promote", actors: ["auto"] }, // low risk: авто в canary (ТЗ §9)
    { to: "queued", kind: "promote", actors: ["auto", "human"] }, // high risk: в очередь (ТЗ §9)
    { to: "archived", kind: "reject", actors: ["auto", "human"] }, // гейт не пройден / отклонён
  ],
  queued: [
    { to: "canary", kind: "promote", actors: ["human"] }, // принять / принять с правкой (ТЗ §12.1)
    { to: "archived", kind: "reject", actors: ["human"] }, // отклонить, причина обязательная
  ],
  canary: [
    { to: "active", kind: "promote", actors: ["auto"] }, // canary-pass: метрики окна (ТЗ §9)
    { to: "candidate", kind: "reject", actors: ["auto", "human"] }, // canary-fail: flag, повтор — новым кандидатом
  ],
  active: [
    { to: "deprecated", kind: "demote", actors: ["auto", "human"] }, // score<θ / 21д / drift (ТЗ §9)
    { to: "queued", kind: "demote", actors: ["auto", "human"] }, // drift широкий scope / contradiction > 7д
  ],
  deprecated: [
    { to: "active", kind: "promote", actors: ["auto", "human"] }, // восстановление score (М3)
    { to: "active", kind: "rollback", actors: ["human", "auto"] }, // rollback 1-клик авто-решения (ТЗ §12.1/§15 M3)
    { to: "archived", kind: "archive", actors: ["auto", "human"] }, // 30 дней без восстановления
  ],
  archived: [], // терминальное: только archived (ТЗ §7.2.1)
};

export interface TransitionRequest {
  readonly from: ItemStatus;
  readonly to: ItemStatus;
  readonly kind: DecisionKind;
  readonly actor: string;
}

/**
 * Проверяет переход; возвращает ребро (для логирования) или бросает
 * InvalidTransitionError с человеческой причиной.
 */
export function checkTransition(req: TransitionRequest): TransitionEdge {
  const edges = STATE_MACHINE[req.from];
  const edge = edges.find((e) => e.to === req.to && e.kind === req.kind);
  if (!edge) {
    const kindsToTarget = edges.filter((e) => e.to === req.to).map((e) => `'${e.kind}'`);
    if (kindsToTarget.length > 0) {
      throw new InvalidTransitionError(
        `переход ${req.from} → ${req.to} требует kind=${kindsToTarget.join(" или kind=")}, передано '${req.kind}'`,
      );
    }
    throw new InvalidTransitionError(
      `переход ${req.from} → ${req.to} запрещён стейт-машиной (допустимые: ${
        edges.length > 0 ? edges.map((e) => e.to).join(", ") : "нет — терминальный статус"
      })`,
    );
  }
  if (edge.kind !== req.kind) {
    throw new InvalidTransitionError(
      `переход ${req.from} → ${req.to} требует kind='${edge.kind}', передано '${req.kind}'`,
    );
  }
  const cls = actorClassOf(req.actor);
  if (!edge.actors.includes(cls)) {
    throw new InvalidTransitionError(
      `переход ${req.from} → ${req.to} недоступен actor-классу '${cls}' (разрешено: ${edge.actors.join(", ")})`,
    );
  }
  return edge;
}

/** Допустимые целевые статусы из текущего (для CLI/отладки). */
export function allowedTargets(from: ItemStatus): readonly ItemStatus[] {
  return [...new Set(STATE_MACHINE[from].map((e) => e.to))];
}
