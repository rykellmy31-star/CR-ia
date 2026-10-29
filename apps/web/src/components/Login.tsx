import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { ApiError, post } from "../lib/api";

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "recover" | "reset">("login");
  const [recoverMsg, setRecoverMsg] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // Link do e-mail de recuperação (?email=&token=): abre direto na redefinição.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const em = q.get("email") ?? "";
    const tk = q.get("token") ?? "";
    if (em && tk) {
      setEmail(em);
      setResetToken(tk);
      setMode("reset");
      setRecoverMsg("Link de recuperação reconhecido. Defina sua nova senha abaixo (válido 1h).");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha no login.");
    } finally {
      setBusy(false);
    }
  };

  const doRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setRecoverMsg("");
    setBusy(true);
    try {
      const r = await post<{ sent: boolean; hint: string }>("/api/auth/recover", { email: email.trim() });
      setRecoverMsg(r.hint);
      setMode("reset");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha na recuperação.");
    } finally {
      setBusy(false);
    }
  };

  const doReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await post("/api/auth/reset", { email: email.trim(), token: resetToken.trim(), newPassword });
      setMode("login");
      setError("");
      setRecoverMsg("Senha redefinida! Faça login com a nova senha.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao redefinir.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 p-4">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-8">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white text-2xl font-black mb-3">
            CR
          </div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">CR IA</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Sua inteligência artificial particular</p>
        </div>

        {mode === "login" && (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">E-mail</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="voce@exemplo.com" autoComplete="email" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Senha</label>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="••••••••" autoComplete="current-password" />
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            {recoverMsg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{recoverMsg}</p>}
            <button disabled={busy} className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-2.5 transition">
              {busy ? "Entrando…" : "Entrar"}
            </button>
            <button type="button" onClick={() => { setMode("recover"); setError(""); }}
              className="w-full text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
              Esqueci minha senha
            </button>
          </form>
        )}

        {mode === "recover" && (
          <form onSubmit={doRecover} className="space-y-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">Informe seu e-mail para gerar um token de recuperação.</p>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="voce@exemplo.com" />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button disabled={busy} className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-2.5">
              {busy ? "Gerando…" : "Gerar token"}
            </button>
            <button type="button" onClick={() => setMode("login")} className="w-full text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
              Voltar ao login
            </button>
          </form>
        )}

        {mode === "reset" && (
          <form onSubmit={doReset} className="space-y-4">
            {recoverMsg && <p className="text-sm text-zinc-600 dark:text-zinc-300">{recoverMsg}</p>}
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail"
              className="w-full rounded-lg border px-3 py-2 border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500" />
            <input required value={resetToken} onChange={(e) => setResetToken(e.target.value)} placeholder="Token recebido"
              className="w-full rounded-lg border px-3 py-2 border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500" />
            <input type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Nova senha (mín. 8 caracteres)"
              className="w-full rounded-lg border px-3 py-2 border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500" />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button disabled={busy} className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-2.5">
              {busy ? "Salvando…" : "Redefinir senha"}
            </button>
            <button type="button" onClick={() => setMode("login")} className="w-full text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
              Voltar ao login
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
