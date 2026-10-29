import { useEffect, useRef, useState } from "react";
import type { GeneratedImage, ImageFormat, ModelInfo } from "@cr-ia/shared";
import { ApiError, API_BASE, api, downloadAuth, fileUrl, post } from "../lib/api";

const FORMATS: { id: ImageFormat; label: string; hint: string }[] = [
  { id: "1:1", label: "1:1 Quadrado", hint: "Feed Instagram/Facebook" },
  { id: "4:5", label: "4:5 Retrato", hint: "Feed destaque" },
  { id: "9:16", label: "9:16 Stories", hint: "Stories, Reels, WhatsApp" },
  { id: "16:9", label: "16:9 Paisagem", hint: "Capa, banner, site" },
];

export function ImageStudio({ models, onOpenSidebar }: { models: ModelInfo[]; onOpenSidebar: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState<ImageFormat>("1:1");
  const [model, setModel] = useState("auto");
  const [brandName, setBrandName] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selected, setSelected] = useState<GeneratedImage | null>(null);
  const [caption, setCaption] = useState("");
  const [captionBusy, setCaptionBusy] = useState(false);
  const [network, setNetwork] = useState<"instagram" | "facebook" | "whatsapp">("instagram");
  const [mode, setMode] = useState<"gen" | "edit">("gen");
  const [editModel, setEditModel] = useState("qwen-image-edit");

  const imgModels = models.filter((m) => m.capabilities.includes("image-gen"));
  const editModels = models.filter((m) => m.capabilities.includes("image-edit"));

  const refresh = async () => {
    try {
      const data = await api<{ images: GeneratedImage[] }>("/api/images");
      setImages(data.images);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar biblioteca.");
    }
  };

  useEffect(() => { void refresh(); }, []);

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await post<{ image: GeneratedImage }>("/api/images/generate", {
        prompt: prompt.trim(),
        format,
        model: model === "auto" ? undefined : model,
        brand: brandName.trim() ? { name: brandName.trim(), color: brandColor.trim() || undefined } : undefined,
      });
      setImages((imgs) => [data.image, ...imgs]);
      setSelected(data.image);
      setCaption("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao gerar imagem.");
    } finally {
      setBusy(false);
    }
  };

  const genCaption = async () => {
    if (!selected || captionBusy) return;
    setCaptionBusy(true);
    setError("");
    try {
      const data = await post<{ caption: string }>(`/api/images/${selected.id}/caption`, { network });
      setCaption(data.caption);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao gerar legenda.");
    } finally {
      setCaptionBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Excluir esta imagem da biblioteca?")) return;
    try {
      await api(`/api/images/${id}`, { method: "DELETE" });
      setImages((imgs) => imgs.filter((i) => i.id !== id));
      if (selected?.id === id) {
        setSelected(null);
        setCaption("");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao excluir.");
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h2 className="font-semibold text-sm">🎨 Estúdio de imagens e marketing</h2>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-5xl mx-auto grid lg:grid-cols-[380px_1fr] gap-4">
          {/* formulário */}
          <div className="space-y-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 h-fit">
            <div>
              <label className="text-sm font-medium">Descreva a arte</label>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4}
                placeholder="Ex.: banner promocional de padaria artesanal, pães dourados, texto 'Pão quentinho toda manhã', cores quentes"
                className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="text-sm font-medium">Formato</label>
              <div className="grid grid-cols-2 gap-2 mt-1">
                {FORMATS.map((f) => (
                  <button key={f.id} onClick={() => setFormat(f.id)}
                    className={`rounded-lg border px-2 py-2 text-left transition ${
                      format === f.id
                        ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-950/50"
                        : "border-zinc-300 dark:border-zinc-700 hover:border-indigo-400"
                    }`}>
                    <div className="text-sm font-semibold">{f.label}</div>
                    <div className="text-[11px] text-zinc-500">{f.hint}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">Modelo</label>
              <select value={model} onChange={(e) => setModel(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm">
                <option value="auto">✨ Automático (melhor disponível)</option>
                {imgModels.map((m) => {
                  const blocked = m.provider === "openrouter" && m.paid && m.status === "available";
                  const usable = (m.status === "installed" || m.status === "available" || m.status === "limited") && m.enabled && !blocked;
                  const dot = m.status === "installed" ? "🟢"
                    : m.status === "limited" ? "⏳"
                    : m.status === "available" ? "🟡"
                    : m.status === "needs-credentials" ? "🔑" : "🔴";
                  return (
                    <option key={m.id} value={m.id} disabled={!usable}>
                      {dot} {m.label}{m.external ? " 🌐" : ""}{blocked ? " (aguardando ativação)" : m.cost === "paid" ? " (pago)" : ""}
                    </option>
                  );
                })}
              </select>
              {(model === "auto"
                ? imgModels.some((m) => m.external && m.available && m.enabled)
                : imgModels.find((m) => m.id === model)?.external) && (
                <p className="text-[11px] text-sky-700 dark:text-sky-300 mt-1">
                  🌐 Este modelo envia o prompt a um provedor externo. Pode haver custos ou limites conforme o modelo. Evite dados sensíveis.
                </p>
              )}
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Identidade visual (opcional)</summary>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Nome da marca"
                  className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm" />
                <input value={brandColor} onChange={(e) => setBrandColor(e.target.value)} placeholder="Cor (ex.: azul)"
                  className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm" />
              </div>
            </details>
            <button onClick={() => void generate()} disabled={busy || !prompt.trim()}
              className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white font-semibold py-2.5 disabled:opacity-50">
              {busy ? "Gerando arte… 🎨" : "Gerar arte ✨"}
            </button>
            {error && <p className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}
            <p className="text-[11px] text-zinc-500">
              Automático: usa sua GPU (ComfyUI) → nuvem gratuita (FLUX, ~1/min) → SVG de demonstração.
              O SVG é só para testes e sempre aparece marcado como demonstração.
            </p>
          </div>

          {/* edição */}
          <div className="space-y-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 h-fit lg:col-start-1">
            <div className="flex gap-1 text-xs">
              <button onClick={() => setMode("gen")} className={`px-2 py-1 rounded-lg ${mode === "gen" ? "bg-indigo-600 text-white" : "bg-zinc-200 dark:bg-zinc-800"}`}>Gerar</button>
              <button onClick={() => setMode("edit")} className={`px-2 py-1 rounded-lg ${mode === "edit" ? "bg-indigo-600 text-white" : "bg-zinc-200 dark:bg-zinc-800"}`}>🖌️ Editar foto</button>
            </div>
            {mode === "edit" && (
              <EditPanel
                models={editModels}
                editModel={editModel} setEditModel={setEditModel}
                onDone={(img) => { setImages((imgs) => [img, ...imgs]); setSelected(img); setCaption(""); }}
              />
            )}
          </div>

          {/* prévia + biblioteca */}
          <div className="space-y-3 min-w-0">
            {selected && (
              <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
                <img src={fileUrl(selected.url)} alt={selected.prompt}
                  className="w-full max-h-[420px] object-contain rounded-xl bg-white dark:bg-black/30" />
                <p className="text-xs text-zinc-500 mt-2 line-clamp-2">“{selected.prompt}” · {selected.format} · {selected.modelId}</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <button onClick={() => void downloadAuth(selected.url, `cr-ia-${selected.id}.img`).catch((e) => setError(String(e)))}
                    className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5">⬇ Baixar</button>
                  <select value={network} onChange={(e) => setNetwork(e.target.value as typeof network)}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm">
                    <option value="instagram">Instagram</option>
                    <option value="facebook">Facebook</option>
                    <option value="whatsapp">WhatsApp</option>
                  </select>
                  <button onClick={() => void genCaption()} disabled={captionBusy}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm px-3 py-1.5 disabled:opacity-50">
                    {captionBusy ? "Escrevendo…" : "✍️ Criar legenda"}
                  </button>
                </div>
                {caption && (
                  <div className="mt-2 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 p-3 text-sm whitespace-pre-wrap">
                    {caption}
                    <button onClick={() => navigator.clipboard.writeText(caption).catch(() => undefined)}
                      className="block mt-2 text-indigo-600 dark:text-indigo-400 text-xs hover:underline">⧉ Copiar legenda</button>
                  </div>
                )}
              </div>
            )}

            <h3 className="font-semibold text-sm">📚 Minha biblioteca ({images.length})</h3>
            {images.length === 0 && <p className="text-sm text-zinc-500">Nenhuma arte ainda. Descreva e gere a primeira!</p>}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {images.map((img) => (
                <div key={img.id} className="group relative rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
                  <img src={fileUrl(img.url)} alt={img.prompt} loading="lazy"
                    onClick={() => { setSelected(img); setCaption(""); }}
                    className="w-full aspect-square object-cover cursor-pointer hover:opacity-90" />
                  <button onClick={() => void remove(img.id)} title="Excluir"
                    className="absolute top-1 right-1 hidden group-hover:block bg-black/60 text-white rounded-lg px-1.5 py-0.5 text-xs">🗑️</button>
                  <div className="px-2 py-1 text-[11px] text-zinc-500 truncate">{img.format} · {new Date(img.createdAt).toLocaleDateString("pt-BR")}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Edição real (upload + instrução) na GPU externa. */
function EditPanel({ models, editModel, setEditModel, onDone }: {
  models: ModelInfo[];
  editModel: string;
  setEditModel: (m: string) => void;
  onDone: (img: GeneratedImage) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [fileId, setFileId] = useState("");
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const effective = models.some((m) => m.id === editModel)
    ? editModel
    : (models.find((m) => (m.status === "installed" || m.status === "limited") && m.enabled)?.id ?? models[0]?.id ?? editModel);
  const active = models.find((m) => m.id === effective);
  const blocked = active?.provider === "openrouter" && active.paid && active.status === "available";
  const ready = !!active && (active.status === "installed" || active.status === "limited") && active.enabled;

  const upload = async (f: File) => {
    setError("");
    try {
      const form = new FormData();
      form.append("file", f);
      const token = localStorage.getItem("cr-ia-token");
      const res = await fetch(`${API_BASE}/api/files`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const body = (await res.json()) as { ok: boolean; error?: string; data?: { file: { id: string } } };
      if (!res.ok || !body.ok || !body.data) throw new Error(body.error ?? "Falha no upload.");
      setFileId(body.data.file.id);
      setPreview(URL.createObjectURL(f));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha no upload.");
    }
  };

  const run = async () => {
    if (!fileId || !prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await post<{ image: GeneratedImage }>("/api/images/edit", {
        fileId, prompt: prompt.trim(), model: effective,
      });
      onDone(data.image);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha na edição.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div>
        <label className="text-sm font-medium">Modelo de edição</label>
        <select value={effective} onChange={(e) => setEditModel(e.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm">
          {models.map((m) => {
            const mBlocked = m.provider === "openrouter" && m.paid && m.status === "available";
            const dot = m.status === "installed" ? "🟢"
              : m.status === "limited" ? "⏳"
              : m.status === "available" ? "🟡"
              : m.status === "needs-credentials" ? "🔑" : "🔴";
            return (
              <option key={m.id} value={m.id} disabled={mBlocked || !m.enabled}>
                {dot} {m.label}{mBlocked ? " (aguardando ativação)" : m.paid ? " (pago)" : ""}
              </option>
            );
          })}
        </select>
        {!ready && (
          <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">
            ⚠️ {active ? `Modelo ${active.status}. ${active.requirements ?? "Configure a GPU externa."}` : "Nenhum modelo de edição disponível. Configure a GPU externa (EXTERNAL_GPU_URL) — ver docs/GPU-EXTERNA.md."}
          </p>
        )}
      </div>
      <div>
        <input ref={inputRef} type="file" className="hidden" accept=".png,.jpg,.jpeg,.webp"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        {!preview ? (
          <button onClick={() => inputRef.current?.click()}
            className="w-full rounded-xl border-2 border-dashed border-zinc-300 dark:border-zinc-700 py-6 text-sm text-zinc-500 hover:border-indigo-400">
            📤 Enviar foto (PNG/JPEG/WebP)
          </button>
        ) : (
          <div className="relative">
            <img src={preview} alt="original" className="w-full max-h-56 object-contain rounded-xl bg-white dark:bg-black/30" />
            <button onClick={() => { setPreview(""); setFileId(""); }} className="absolute top-1 right-1 bg-black/60 text-white rounded-lg px-2 py-0.5 text-xs">Trocar</button>
          </div>
        )}
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
        placeholder="Ex.: troque o fundo por uma praia ao pôr do sol, mantendo a pessoa"
        className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
      <button onClick={() => void run()} disabled={busy || !fileId || !prompt.trim() || !ready}
        className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white font-semibold py-2.5 disabled:opacity-50">
        {busy ? "Editando na GPU… 🖌️" : "Editar foto ✨"}
      </button>
      {error && <p className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}
    </div>
  );
}
