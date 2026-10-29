/** Senhas (bcryptjs, puro-JS) + JWT (jose, portátil Node/Workers). */
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import type { AuthUser } from "../types.js";

export async function hashPassword(password: string, cost = 10): Promise<string> {
  const salt = await bcrypt.genSalt(cost);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signToken(
  user: AuthUser,
  secret: string,
  expiresIn = "12h",
  tokenVersion = 1
): Promise<string> {
  return new SignJWT({ sub: user.id, email: user.email, name: user.name, role: user.role, tv: tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey(secret));
}

export interface VerifiedUser extends AuthUser {
  /** Versão do token (revogação global: divergente da atual = inválido). */
  tokenVersion: number;
}

export async function verifyToken(token: string, secret: string): Promise<VerifiedUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const role = payload.role as string;
    if (role !== "admin" && role !== "guest" && role !== "user") return null;
    const tv = typeof payload.tv === "number" && payload.tv >= 1 ? payload.tv : 1;
    return {
      id: payload.sub,
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      role,
      tokenVersion: tv,
    };
  } catch {
    return null;
  }
}

/** Token opaco para recuperação de acesso. */
export function opaqueToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
