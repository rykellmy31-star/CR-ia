/**
 * Redação de segredos em logs (§11): tokens/chaves/senhas nunca vazam.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/lib/redact.js";

describe("redactSecrets", () => {
  it("mascara Bearer, chaves conhecidas e pares k=v", () => {
    const out = redactSecrets(
      "auth Bearer abcDEF123.-_~+/= e groq gsk_abcdefgh12345678 " +
      "api_key=SECRETO123 token: xyz98765 postgres://u:SENHA456@db:5432/x",
    );
    expect(out).toContain("Bearer ***");
    expect(out).not.toContain("abcDEF123");
    expect(out).not.toContain("gsk_abcdefgh");
    expect(out).not.toContain("SECRETO123");
    expect(out).not.toContain("SENHA456");
    expect(out).toContain("postgres://u:***@db:5432/x");
  });

  it("mascara chave privada PEM e é idempotente", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nABCDEF\n-----END EC PRIVATE KEY-----";
    const once = redactSecrets(`k=${pem}`);
    expect(once).not.toContain("ABCDEF");
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets("texto normal sem segredo")).toBe("texto normal sem segredo");
  });
});
