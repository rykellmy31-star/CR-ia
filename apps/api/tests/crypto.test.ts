import { describe, expect, it } from "vitest";
import { hashPassword, opaqueToken, signToken, verifyPassword, verifyToken } from "../src/lib/crypto.js";

describe("crypto", () => {
  it("hash + verify de senha", async () => {
    const hash = await hashPassword("MinhaSenh@123", 4);
    expect(await verifyPassword("MinhaSenh@123", hash)).toBe(true);
    expect(await verifyPassword("errada", hash)).toBe(false);
  });

  it("JWT assina e verifica", async () => {
    const token = await signToken(
      { id: "u1", email: "a@b.c", name: "A", role: "admin" },
      "segredo-de-teste-com-32-caracteres!!",
      "1h"
    );
    const user = await verifyToken(token, "segredo-de-teste-com-32-caracteres!!");
    expect(user?.id).toBe("u1");
    expect(user?.role).toBe("admin");
    expect(await verifyToken(token, "outro-segredo-diferente-12345678")).toBeNull();
  });

  it("tokens opacos são únicos", () => {
    expect(opaqueToken()).not.toBe(opaqueToken());
  });
});
