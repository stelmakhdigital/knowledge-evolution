import type { ItemType, ItemStatus } from "../../src/domain/types.js";

/**
 * Golden-набор M2 (критерий TЗ §15: recall@5 ≥ 0.7 на 30 задачах).
 * Детерминированный фикстурный мир: 12 элементов (темы с различимым словарём)
 * и 30 запросов с ожидаемыми элементами. Используется только в тестах на живом PG.
 */

export interface GoldenItem {
  readonly id: string;
  readonly type: ItemType;
  readonly title: string;
  readonly scope: string;
  readonly tags: readonly string[];
  readonly appliesTo: string;
  readonly status: ItemStatus;
  readonly body: string;
}

export interface GoldenTask {
  readonly id: string;
  readonly query: string;
  /** Идентификаторы элементов, ожидаемые в top-5 (recall@5 = |∩| / |expected|). */
  readonly expected: readonly string[];
  readonly scopeHints?: readonly string[];
}

export const GOLDEN_ITEMS: readonly GoldenItem[] = [
  {
    id: "g1",
    type: "heuristic",
    title: "сначала прогоняй migration-тест",
    scope: "db/migrations",
    tags: ["db", "migrations"],
    appliesTo: "all",
    status: "active",
    body: "Миграции лежат в db/migrations. Перед изменением схемы БД сначала прогоняй migration-тест, потом меняй сущности. Откат схемы — только новой миграцией.",
  },
  {
    id: "g2",
    type: "skill",
    title: "обновляй openapi-спеку до кода",
    scope: "src/api/**",
    tags: ["api", "openapi"],
    appliesTo: "all",
    status: "active",
    body: "При изменении API-контракта сначала обнови openapi-спеку (openapi.yaml), затем код контроллера. Генерируй клиент заново, не правь его руками.",
  },
  {
    id: "g3",
    type: "negative",
    title: "не коммитить .env и секреты",
    scope: "all",
    tags: ["secrets", "env"],
    appliesTo: "all",
    status: "active",
    body: "Никогда не добавляй .env или секреты в git. Секреты живут в vault; в конфиге — только ссылки. Если секрет попал в коммит — валидация CI должна его поймать.",
  },
  {
    id: "g4",
    type: "heuristic",
    title: "снапшоты vitest — только для стабильных DOM",
    scope: "test/**",
    tags: ["vitest", "tests"],
    appliesTo: "all",
    status: "active",
    body: "Тесты пишутся в vitest. Снапшот-тесты используй только для стабильных DOM-деревьев; для вычислений — обычные expect. Снапшоты чисти раз в неделю.",
  },
  {
    id: "g5",
    type: "heuristic",
    title: "атомарные коммиты с type-префиксом",
    scope: "all",
    tags: ["git"],
    appliesTo: "all",
    status: "active",
    body: "Коммиты — атомарные, по одному логическому изменению. Формат message: type: краткое описание (fix:, feat:, chore:). Не смешивай рефакторинг и фикс в одном коммите.",
  },
  {
    id: "g6",
    type: "skill",
    title: "useCallback для memo-списков React",
    scope: "src/web/**",
    tags: ["react", "frontend"],
    appliesTo: "all",
    status: "active",
    body: "В React-компонентах: колбэки, уходящие в memo-избранные списки, оборачивай в useCallback. Иначе список перерисовывается целиком. Проверка — React DevTools Profiler.",
  },
  {
    id: "g7",
    type: "fact",
    title: "CI: кэш npm и образ ubuntu-24.04",
    scope: ".github/**",
    tags: ["ci"],
    appliesTo: "all",
    status: "active",
    body: "CI крутится на образе ubuntu-24.04. Кэш npm-пакетов — в ~/.cache/node-gyp и actions/cache по хэшу package-lock.json. Без кэша сборка на 40% дольше.",
  },
  {
    id: "g8",
    type: "heuristic",
    title: "виртуализация длинных списков",
    scope: "src/web/**",
    tags: ["performance", "frontend"],
    appliesTo: "all",
    status: "active",
    body: "Списки длиннее 500 элементов виртуализируй (react-window). Метрика: FPS при скролле не падает ниже 50. Проверяй на слабых устройствах.",
  },
  {
    id: "g9",
    type: "fact",
    title: "GIN-индекс для полнотекста",
    scope: "db/**",
    tags: ["postgres", "indexes"],
    appliesTo: "all",
    status: "active",
    body: "Медленный запрос по текстовому полю в Postgres — добавляй GIN-индекс: CREATE INDEX ... USING gin (to_tsvector('simple', body)). Проверь plan через EXPLAIN ANALYZE.",
  },
  {
    id: "g10",
    type: "heuristic",
    title: "structured-логи с correlation_id",
    scope: "src/**",
    tags: ["logging"],
    appliesTo: "all",
    status: "canary",
    body: "Логирование — structured JSON, каждое сообщение несёт correlation_id. Плоские строки в логах запрещены: их невозможно агрегировать по задаче.",
  },
  {
    id: "g11",
    type: "fact",
    title: "legacy-x только в ветке legacy",
    scope: "all",
    tags: ["legacy"],
    appliesTo: "all",
    status: "archived",
    body: "Фреймворк legacy-x использовать можно только в ветке legacy. В main он удалён — новый код на нём не пишется никогда.",
  },
  {
    id: "g12",
    type: "heuristic",
    title: "dsh: не грейпать node_modules",
    scope: "all",
    tags: ["dsh", "tooling"],
    appliesTo: "dsh",
    status: "active",
    body: "Для агента dsh: не запускай grep/ripgrep по node_modules — это тратит минуты. Ищи только по src и dist; зависимости читай через docs пакета.",
  },
];

export const GOLDEN_TASKS: readonly GoldenTask[] = [
  { id: "t01", query: "как безопасно изменить схему БД и не сломать миграции", expected: ["g1"], scopeHints: ["db/migrations"] },
  { id: "t02", query: "миграция базы данных упала, что делать со схемой", expected: ["g1"] },
  { id: "t03", query: "нужно поменять endpoint API, с чего начать", expected: ["g2"], scopeHints: ["src/api/**"] },
  { id: "t04", query: "контроллер API меняю контракт ответа", expected: ["g2"] },
  { id: "t05", query: "openapi спецификация и клиент, порядок правок", expected: ["g2"] },
  { id: "t06", query: "случайно добавил .env в коммит, что делать", expected: ["g3"] },
  { id: "t07", query: "где хранить секреты приложения и пароли БД", expected: ["g3"] },
  { id: "t08", query: "написать тесты на новые функции, какой фреймворк", expected: ["g4"] },
  { id: "t09", query: "снапшот-тест для DOM компонента — стоит ли", expected: ["g4"] },
  { id: "t10", query: "формат сообщения коммита и размер коммита", expected: ["g5"] },
  { id: "t11", query: "смешивать рефакторинг и фикс бага в коммите", expected: ["g5"] },
  { id: "t12", query: "React список перерисовывается целиком, причины", expected: ["g6"] },
  { id: "t13", query: "колбэк пропс в memo компоненте, как остановить ре-рендер", expected: ["g6"] },
  { id: "t14", query: "CI медленный, как ускорить сборку", expected: ["g7"] },
  { id: "t15", query: "кэш npm пакетов в пайплайне", expected: ["g7"] },
  { id: "t16", query: "таблица с 10000 строк тормозит на скролле", expected: ["g8"] },
  { id: "t17", query: "виртуализация списка react, как применить", expected: ["g8"] },
  { id: "t18", query: "postgres поиск по тексту медленный, индекс", expected: ["g9"] },
  { id: "t19", query: "GIN индекс tsvector для полнотекстового поиска", expected: ["g9"] },
  { id: "t20", query: "как оформить логи по задаче, correlation id", expected: ["g10"] },
  { id: "t21", query: "структурированное логирование json, требования", expected: ["g10"] },
  { id: "t22", query: "какие коммиты допустимы по размеру и структуре", expected: ["g5"] },
  { id: "t23", query: "схема БД и миграции: порядок действий", expected: ["g1", "g9"] },
  { id: "t24", query: "фронтенд: длинные списки и перерисовка компонентов", expected: ["g6", "g8"] },
  { id: "t25", query: "тесты vitest и чистка снапшотов", expected: ["g4"] },
  { id: "t26", query: "секреты в окружении и vault, политика", expected: ["g3"] },
  { id: "t27", query: "api контракт: openapi и контроллер, последовательность", expected: ["g2"] },
  { id: "t28", query: "git история: атомарность и префиксы типа", expected: ["g5"] },
  { id: "t29", query: "медленный запрос postgre и план выполнения", expected: ["g9"] },
  { id: "t30", query: "перерисовка списка в react и виртуализация строк", expected: ["g8", "g6"] },
];
