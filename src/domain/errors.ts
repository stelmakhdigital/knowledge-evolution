/** Базовая доменная ошибка: машиночитаемый code + человекочитаемое сообщение (ts-rules). */
export class EvolveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvolveError";
    this.code = code;
  }
}

/** Запрошенный переход статусов запрещён стейт-машиной (ТЗ §9). */
export class InvalidTransitionError extends EvolveError {
  constructor(message: string) {
    super("INVALID_TRANSITION", message);
    this.name = "InvalidTransitionError";
  }
}

/** Сущность не найдена. */
export class NotFoundError extends EvolveError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

/** Нарушение инвариантов записи (ТЗ §8: единственный путь — кандидат + гейты). */
export class InvariantViolationError extends EvolveError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "InvariantViolationError";
  }
}
