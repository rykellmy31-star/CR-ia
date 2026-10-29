/**
 * Redação de segredos em logs/históricos: tokens, chaves e senhas nunca
 * devem aparecer em log de update, auditoria ou erro visível.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer ***"],
  [/\b(sk|rk|gsk|or-v1|hf|ghp|gho|AIza|xox)[A-Za-z0-9\-_]{8,}\b/g, "***KEY***"],
  [/((?:api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*["':=]\s*["']?)([^"'\s&;}]{4,})/gi, "$1***"],
  [/(postgres(?:ql)?:\/\/[^/\s:]+:)([^@/\s]+)(@)/gi, "$1***$3"],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1 *** $2"],
];

/** Substitui segredos reconhecíveis por *** (idempotente). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
