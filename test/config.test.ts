import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveConfigPath } from "../src/config/config.js";

/** Связанный конфиг проекта — эталон валидности. */
const VALID_YAML = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "evolve-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string): string => {
    const p = path.join(dir, name);
    writeFileSync(p, content, "utf8");
    return p;
  };

  it("загружает валидный config.yaml со всеми порогами", () => {
    const cfg = loadConfig(write("ok.yaml", VALID_YAML));
    expect(cfg.theta_dedup).toBe(0.85);
    expect(cfg.budget.active_max).toBe(300);
    expect(cfg.retrieval.mode).toBe("hybrid");
    expect(cfg.score.min_used).toBe(5);
  });

  it("бросает ConfigError CONFIG_NOT_FOUND для отсутствующего файла", () => {
    const err = (() => {
      try {
        loadConfig(path.join(dir, "nope.yaml"));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe("CONFIG_NOT_FOUND");
  });

  const brokenCases = [
    { name: "yaml-сломан", content: "version: [1\n  bad: {", code: "CONFIG_INVALID" },
    { name: "нет-ключа", content: VALID_YAML.replace("theta_dedup: 0.85", ""), code: "CONFIG_INVALID" },
    { name: "плохое-значение", content: VALID_YAML.replace("mode: hybrid", "mode: quantum"), code: "CONFIG_INVALID" },
  ] as const;

  for (const { name, content, code } of brokenCases) {
    it(`бросает ConfigError(${code}) для ${name}`, () => {
      const err = (() => {
        try {
          loadConfig(write(`${name}.yaml`, content));
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe(code);
    });
  }
});

describe("resolveConfigPath", () => {
  it("возвращает $EVOLVE_CONFIG при непустом значении", () => {
    expect(resolveConfigPath({ EVOLVE_CONFIG: "custom.yaml" })).toBe("custom.yaml");
  });

  it("возвращает ./config.yaml при отсутствии переменной", () => {
    expect(resolveConfigPath({})).toBe("config.yaml");
  });

  it("возвращает ./config.yaml для пустой переменной", () => {
    expect(resolveConfigPath({ EVOLVE_CONFIG: "" })).toBe("config.yaml");
  });
});
