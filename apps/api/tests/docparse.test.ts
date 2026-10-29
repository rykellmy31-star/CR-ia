/** Leitura REAL de documentos: TXT/MD/CSV/JSON/PDF/DOCX/XLSX (fixtures gerados). */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { chunkText, extractTextFromFile } from "../src/services/docparse.js";

/** PDF mínimo válido (1 página, Helvetica, sem compressão). */
function minimalPdf(text: string): Uint8Array {
  const enc = new TextEncoder();
  const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${esc}) Tj ET`;
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(enc.encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = enc.encode(pdf).length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return enc.encode(pdf);
}

/** DOCX mínimo válido (zip "stored" montado à mão — sem dependências). */
function minimalDocx(paragraphs: string[]): Uint8Array {
  const enc = new TextEncoder();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxml-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;
  const files: Array<[string, Uint8Array]> = [
    ["[Content_Types].xml", enc.encode(contentTypes)],
    ["_rels/.rels", enc.encode(rels)],
    ["word/document.xml", enc.encode(doc)],
  ];
  // Writer ZIP "stored" (método 0) com CRC32 real.
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nb = enc.encode(name);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // UTF-8
    head.setUint16(8, 0, true); // stored
    head.setUint32(14, crc32(data), true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(head.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint32(16, crc32(data), true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nb.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const centralSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of [...parts, ...central, new Uint8Array(end.buffer)]) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

describe("extractTextFromFile (REAL)", () => {
  it("lê TXT/MD/JSON", async () => {
    const enc = new TextEncoder();
    const t = await extractTextFromFile("text/plain", enc.encode("Olá mundo"), "a.txt");
    expect(t.text).toContain("Olá mundo");
    const j = await extractTextFromFile("application/json", enc.encode('{"a":1}'), "a.json");
    expect(j.text).toContain('"a":1');
  });

  it("lê PDF real de 1 página", async () => {
    const r = await extractTextFromFile("application/pdf", minimalPdf("Contrato de teste CR IA"), "c.pdf");
    expect(r.text).toContain("Contrato de teste CR IA");
    expect(r.meta.pages).toBe(1);
  });

  it("lê DOCX real", async () => {
    const r = await extractTextFromFile(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      minimalDocx(["Primeiro parágrafo", "Segundo parágrafo"]),
      "doc.docx"
    );
    expect(r.text).toContain("Primeiro parágrafo");
    expect(r.text).toContain("Segundo parágrafo");
  });

  it("lê XLSX real com 2 abas", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["nome", "valor"], ["café", 10]]), "Vendas");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["ok"]]), "Outros");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
    const r = await extractTextFromFile(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf, "plan.xlsx"
    );
    expect(r.text).toContain("café");
    expect(r.text).toContain("Vendas");
    expect(r.meta.sheets).toContain("Vendas");
  });

  it("rejeita tipo não-documento com mensagem clara", async () => {
    await expect(extractTextFromFile("image/png", new Uint8Array([1, 2, 3]), "a.png"))
      .rejects.toThrow("não suportada");
  });
});

describe("chunkText", () => {
  it("divide textos longos com sobreposição", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Parágrafo ${i} com conteúdo relevante.`).join("\n\n");
    const chunks = chunkText(text, 300, 50);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join(" ")).toContain("Parágrafo 0");
    expect(chunks.join(" ")).toContain("Parágrafo 49");
  });

  it("texto curto vira 1 chunk", () => {
    expect(chunkText("oi")).toEqual(["oi"]);
    expect(chunkText("   ")).toEqual([]);
  });
});
