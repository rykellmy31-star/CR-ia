import { useState } from "react";
import type { Conversation } from "@cr-ia/shared";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import type { View } from "../App";

interface Props {
  view: View;
  setView: (v: View) => void;
  conversations: Conversation[];
  activeConv: string | null;
  onSelectConv: (id: string | null) => void;
  onNewChat: () => void;
  onSearch: (q: string) => void;
  onDeleteConv: (id: string) => void;
  onRenameConv: (id: string, title: string) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
}

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "chat", label: "Conversar", icon: "💬" },
  { id: "search", label: "Pesquisar", icon: "🌐" },
  { id: "memory", label: "Memória", icon: "🧠" },
  { id: "code", label: "Código", icon: "💻" },
  { id: "models", label: "Modelos", icon: "🧩" },
  { id: "agent", label: "Agente dev", icon: "🛠️" },
  { id: "images", label: "Estúdio de imagens", icon: "🎨" },
  { id: "tasks", label: "Tarefas", icon: "🤖" },
  { id: "files", label: "Arquivos", icon: "📁" },
  { id: "admin", label: "Administração", icon: "⚙️" },
];

export function Sidebar(p: Props) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const items = NAV.filter((n) => n.id !== "admin" || user?.role === "admin");

  return (
    <>
      {/* overlay mobile */}
      {p.open && (
        <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => p.setOpen(false)} />
      )}
      <aside
        className={`fixed md:static z-40 h-full w-72 shrink-0 flex flex-col bg-zinc-100 dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 transition-transform ${
          p.open ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="p-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white flex items-center justify-center font-black">
              CR
            </div>
            <div className="flex-1">
              <div className="font-bold leading-tight">CR IA</div>
              <div className="text-xs text-zinc-500 truncate">{user?.name} · {user?.role === "admin" ? "Admin" : "Convidada"}</div>
            </div>
            <button onClick={toggle} title={theme === "dark" ? "Tema claro" : "Tema escuro"}
              className="w-9 h-9 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 text-lg">
              {theme === "dark" ? "☀️" : "🌙"}
            </button>
          </div>
          <nav className="space-y-1">
            {items.map((n) => (
              <button key={n.id} onClick={() => { p.setView(n.id); p.setOpen(false); }}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${
                  p.view === n.id
                    ? "bg-indigo-600 text-white"
                    : "hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
                }`}>
                <span className="mr-2">{n.icon}</span>{n.label}
              </button>
            ))}
          </nav>
        </div>

        {p.view === "chat" && (
          <div className="flex-1 flex flex-col min-h-0 p-3">
            <button onClick={p.onNewChat}
              className="w-full rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-700 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 text-sm font-semibold py-2 mb-2 transition">
              ＋ Nova conversa
            </button>
            <input value={q} onChange={(e) => { setQ(e.target.value); p.onSearch(e.target.value); }}
              placeholder="🔍 Buscar conversas…" className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm mb-2 outline-none focus:ring-2 focus:ring-indigo-500" />
            <div className="flex-1 overflow-y-auto space-y-1">
              {p.conversations.map((c) => (
                <div key={c.id} className={`group rounded-lg px-2 py-1.5 text-sm cursor-pointer flex items-center gap-1 ${
                  p.activeConv === c.id ? "bg-indigo-100 dark:bg-indigo-950 text-indigo-900 dark:text-indigo-100" : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
                }`} onClick={() => { p.onSelectConv(c.id); p.setOpen(false); }}>
                  {editing === c.id ? (
                    <input autoFocus value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={() => { if (editTitle.trim()) p.onRenameConv(c.id, editTitle.trim()); setEditing(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { if (editTitle.trim()) p.onRenameConv(c.id, editTitle.trim()); setEditing(null); } if (e.key === "Escape") setEditing(null); }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 min-w-0 rounded border px-1 py-0.5 text-sm bg-white dark:bg-zinc-900" />
                  ) : (
                    <span className="flex-1 truncate">💭 {c.title}</span>
                  )}
                  <span className="hidden group-hover:flex gap-1">
                    <button title="Renomear" onClick={(e) => { e.stopPropagation(); setEditing(c.id); setEditTitle(c.title); }} className="hover:opacity-70">✏️</button>
                    <button title="Excluir" onClick={(e) => { e.stopPropagation(); if (confirm("Excluir esta conversa e todo o histórico?")) p.onDeleteConv(c.id); }} className="hover:opacity-70">🗑️</button>
                  </span>
                </div>
              ))}
              {p.conversations.length === 0 && (
                <p className="text-xs text-zinc-500 text-center mt-4">Nenhuma conversa ainda.<br />Comece uma nova acima.</p>
              )}
            </div>
          </div>
        )}

        <div className="p-3 border-t border-zinc-200 dark:border-zinc-800">
          <button onClick={logout} className="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
            🚪 Sair ({user?.email})
          </button>
        </div>
      </aside>
    </>
  );
}
