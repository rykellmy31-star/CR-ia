/**
 * SSRF do leitor de URLs (§8/§11): bloqueios sem tocar na rede.
 * (Caminho feliz com rede real é coberto por teste live opcional.)
 */
import { describe, expect, it } from "vitest";
import { readPublicUrl } from "../src/services/urlreader.js";

describe("readPublicUrl (anti-SSRF)", () => {
  it("bloqueia hosts privados literais", async () => {
    for (const u of [
      "http://127.0.0.1:8888/x", "http://10.1.2.3/", "http://192.168.0.1/",
      "http://169.254.169.254/latest", "http://localhost:3000/",
    ]) {
      await expect(readPublicUrl(u), u).rejects.toThrow(/bloqueado|privad/i);
    }
  });

  it("bloqueia credenciais, esquemas e URL inválida", async () => {
    await expect(readPublicUrl("http://u:p@example.com/")).rejects.toThrow(/credenciais/);
    await expect(readPublicUrl("file:///etc/passwd")).rejects.toThrow(/http\(s\)/);
    await expect(readPublicUrl("xx")).rejects.toThrow(/inválida/);
  });
});
