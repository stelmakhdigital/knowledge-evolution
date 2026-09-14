/**
 * LLM-клиент как инъекция (M0: MockLlm; M1: реальный API по ТЗ A4).
 * Ядро не знает о конкретной модели (agent-agnostic, ТЗ §14).
 */

export interface ConflictVerdict {
  readonly conflicting: boolean;
  /** Доказательство для decisions/contradictions (цитата, объяснение). */
  readonly evidence: string;
}

export interface LlmClient {
  /** Вектор для dедупликации (G2). Длина фиксирована у одного клиента. */
  embed(text: string): readonly number[];
  /** Детектор противоречий (G3): конфликт ли утверждение A с утверждением B. */
  detectConflict(a: string, b: string): Promise<ConflictVerdict>;
}

/** Детерминированный mock для M0-тестов: без сети, без случайности. */
export class MockLlm implements LlmClient {
  private readonly dim: number;
  private readonly conflictPairs: ReadonlyArray<readonly [string, string]>;

  /**
   * @param dim размерность эмбеддинга (дефолт 64 — меньше коллизий хэша токенов,
   *            чтобы cos_sim уникальных текстов оставался заметно ниже θ_dedup)
   * @param conflictPairs пары фрагментов, которые «противоречат» (для сценариев G3)
   */
  constructor(dim = 64, conflictPairs: ReadonlyArray<readonly [string, string]> = []) {
    this.dim = dim;
    this.conflictPairs = conflictPairs;
  }

  embed(text: string): readonly number[] {
    // Частотный профиль токенов → детерминированный нормализованный вектор.
    const vec = new Array<number>(this.dim).fill(0);
    for (const token of text.toLowerCase().match(/[a-zа-яё0-9_/-]+/gi) ?? []) {
      const idx = Math.abs(this.hash(token)) % this.dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
    return norm === 0 ? vec : vec.map((x) => x / norm);
  }

  async detectConflict(a: string, b: string): Promise<ConflictVerdict> {
    const hit = this.conflictPairs.find(
      ([x, y]) =>
        (a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x)),
    );
    return hit
      ? { conflicting: true, evidence: `mock: противоречие «${hit[0]}» ↔ «${hit[1]}»` }
      : { conflicting: false, evidence: "" };
  }

  private hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return h;
  }
}

/** Косинусное сходство двух векторов равной длины. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: разные длины векторов (${a.length} ≠ ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
