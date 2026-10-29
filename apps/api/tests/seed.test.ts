import { describe, expect, it } from "vitest";
import { validateSeedInput, type SeedAccount } from "../src/seed.js";

const good: SeedAccount[] = [
  { email: "admin@x.com", name: "Admin", password: "Forte123!", role: "admin", label: "ADMIN" },
  { email: "guest@x.com", name: "Guest", password: "Forte456!", role: "guest", label: "GUEST" },
];

describe("validateSeedInput", () => {
  it("aceita contas válidas (dev e prod)", () => {
    expect(validateSeedInput(good, false)).toEqual([]);
    expect(validateSeedInput(good, true)).toEqual([]);
  });

  it("RECUSA senha padrão em produção", () => {
    const bad = good.map((a) => ({ ...a, password: "Trocar123!" }));
    const problems = validateSeedInput(bad, true);
    expect(problems.length).toBe(2);
    expect(problems[0]).toMatch(/ADMIN_PASSWORD.*padrão.*PRODUÇÃO/);
  });

  it("permite senha padrão em dev (com aviso em runtime)", () => {
    const bad = good.map((a) => ({ ...a, password: "Trocar123!" }));
    expect(validateSeedInput(bad, false)).toEqual([]);
  });

  it("exige senha 8+ e e-mail válido", () => {
    const bad: SeedAccount[] = [
      { email: "nao-email", name: "A", password: "curta", role: "admin", label: "ADMIN" },
      good[1],
    ];
    const problems = validateSeedInput(bad, false);
    expect(problems.some((p) => p.includes("EMAIL inválido"))).toBe(true);
    expect(problems.some((p) => p.includes("8 caracteres"))).toBe(true);
  });
});
