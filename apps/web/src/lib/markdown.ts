/** Mini-renderizador Markdown → HTML seguro (sem dependências). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  let h = esc(s);
  // código inline
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  // negrito + itálico
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // links [t](u)
  h = h.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // URLs soltas
  h = h.replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  return h;
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join("<br/>")}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      closeList();
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push("<hr/>");
      continue;
    }
    const bq = line.match(/^&gt;|^>/);
    void bq;
    if (line.trim().startsWith(">")) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(line.trim().slice(1).trim())}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul?.[1] ?? ol?.[1] ?? "").trim())}</li>`);
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  closeList();
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  return out.join("\n");
}
