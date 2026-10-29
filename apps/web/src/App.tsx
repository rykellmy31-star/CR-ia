import { useCallback, useEffect, useState } from "react";
import type { Conversation, ModelInfo } from "@cr-ia/shared";
import { AuthProvider, useAuth } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import { api } from "./lib/api";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { ImageStudio } from "./components/ImageStudio";
import { TasksView } from "./components/TasksView";
import { FilesView } from "./components/FilesView";
import { AdminView } from "./components/AdminView";
import { ModelsView } from "./components/ModelsView";
import { AgentView } from "./components/AgentView";
import { SearchView } from "./components/SearchView";
import { MemoryView } from "./components/MemoryView";
import { CodeView } from "./components/CodeView";

export type View = "chat" | "search" | "memory" | "code" | "models" | "agent" | "images" | "tasks" | "files" | "admin";

function Shell() {
  const { user, loading } = useAuth();
  const [view, setView] = useState<View>("chat");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");

  const refreshConvs = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api<{ conversations: Conversation[] }>(
        `/api/chat/conversations${search ? `?q=${encodeURIComponent(search)}` : ""}`
      );
      setConversations(data.conversations);
    } catch {
      /* mantém lista atual */
    }
  }, [user, search]);

  const refreshModels = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api<{ models: ModelInfo[] }>("/api/models");
      setModels(data.models);
    } catch {
      /* mantém */
    }
  }, [user]);

  useEffect(() => {
    void refreshConvs();
    void refreshModels();
  }, [refreshConvs, refreshModels]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-white dark:bg-zinc-950">
        <div className="text-center">
          <div className="text-4xl mb-2">✨</div>
          <p className="text-sm text-zinc-500">Carregando CR IA…</p>
        </div>
      </div>
    );
  }

  if (!user) return <Login />;

  const onDeleteConv = async (id: string) => {
    try {
      await api(`/api/chat/conversations/${id}`, { method: "DELETE" });
      if (activeConv === id) setActiveConv(null);
      await refreshConvs();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Falha ao excluir.");
    }
  };

  const onRenameConv = async (id: string, title: string) => {
    try {
      await api(`/api/chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
      await refreshConvs();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Falha ao renomear.");
    }
  };

  return (
    <div className="h-full flex bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <Sidebar
        view={view} setView={setView}
        conversations={conversations} activeConv={activeConv}
        onSelectConv={setActiveConv}
        onNewChat={() => { setActiveConv(null); setSidebarOpen(false); }}
        onSearch={setSearch}
        onDeleteConv={(id) => void onDeleteConv(id)}
        onRenameConv={(id, t) => void onRenameConv(id, t)}
        open={sidebarOpen} setOpen={setSidebarOpen}
      />
      <main className="flex-1 flex min-w-0">
        {view === "chat" && (
          <ChatView
            conversations={conversations} activeConv={activeConv} setActiveConv={setActiveConv}
            refreshConvs={refreshConvs} models={models} onOpenSidebar={() => setSidebarOpen(true)}
          />
        )}
        {view === "search" && <SearchView onOpenSidebar={() => setSidebarOpen(true)} />}
        {view === "memory" && <MemoryView onOpenSidebar={() => setSidebarOpen(true)} />}
        {view === "code" && <CodeView onOpenSidebar={() => setSidebarOpen(true)} />}
        {view === "models" && (
          <ModelsView models={models} refreshModels={refreshModels} isAdmin={user.role === "admin"} onOpenSidebar={() => setSidebarOpen(true)} />
        )}
        {view === "agent" && (
          <AgentView isAdmin={user.role === "admin"} onOpenSidebar={() => setSidebarOpen(true)} />
        )}
        {view === "images" && <ImageStudio models={models} onOpenSidebar={() => setSidebarOpen(true)} />}
        {view === "tasks" && <TasksView onOpenSidebar={() => setSidebarOpen(true)} />}
        {view === "files" && <FilesView onOpenSidebar={() => setSidebarOpen(true)} />}
        {view === "admin" && (
          user.role === "admin"
            ? <AdminView models={models} refreshModels={refreshModels} onOpenSidebar={() => setSidebarOpen(true)} />
            : <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">Acesso restrito ao administrador.</div>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ThemeProvider>
  );
}
