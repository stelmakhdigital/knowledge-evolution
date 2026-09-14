import type { LlmClient } from "./client.js";

/**
 * Текстовый LLM-клиент (M1: экстрактор, детектор конфликтов).
 * Реализация по API — подключение в M1 при наличии LLM-API (ТЗ A4);
 * до тех пор — MockTextLlm для детерминированных тестов.
 */
export interface TextLlmClient {
  complete(prompt: string): Promise<string>;
}

/** Детерминированный mock: сценарии «фрагмент промпта → ответ». */
export class MockTextLlm implements TextLlmClient {
  private readonly scenarios: ReadonlyArray<readonly [string, string]>;
  private readonly defaultResponse: string;
  private readonly calls: string[] = [];

  constructor(
    scenarios: ReadonlyArray<readonly [string, string]> = [],
    defaultResponse = "",
  ) {
    this.scenarios = scenarios;
    this.defaultResponse = defaultResponse;
  }

  async complete(prompt: string): Promise<string> {
    this.calls.push(prompt);
    const hit = this.scenarios.find(([needle]) => prompt.includes(needle));
    return hit ? hit[1] : this.defaultResponse;
  }

  /** Для тестов: что просили. */
  lastPrompt(): string | undefined {
    return this.calls.at(-1);
  }

  callCount(): number {
    return this.calls.length;
  }
}

/** Комбинирование: текстовый клиент + векторный (один реальный LLM — оба интерфейса). */
export class CombinedLlm implements LlmClient, TextLlmClient {
  constructor(
    private readonly vectors: LlmClient,
    private readonly text: TextLlmClient,
  ) {}

  embed(text: string): readonly number[] {
    return this.vectors.embed(text);
  }

  detectConflict(a: string, b: string) {
    return this.vectors.detectConflict(a, b);
  }

  complete(prompt: string): Promise<string> {
    return this.text.complete(prompt);
  }
}
