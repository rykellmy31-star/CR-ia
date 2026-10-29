import { describe, expect, it, vi } from "vitest";
import { NvidiaCosmosImageAdapter, NVIDIA_COSMOS_IMAGE_ID } from "../src/adapters/ai/nvidia-image.js";
import { nvidiaEmbed, nvidiaRerank } from "../src/services/nvidia-retrieval.js";

const tinyJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]).toString("base64");
const input = { model: NVIDIA_COSMOS_IMAGE_ID, prompt: "Fábrica com braço robótico", format: "1:1" as const, width: 1024, height: 1024 };

function fakeImageFetch(status = 200, body: unknown = { b64_image: tinyJpeg }) {
  return vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "retry-after": "15" },
  })) as unknown as typeof fetch;
}

describe("NVIDIA Cosmos3 Nano Free Endpoint", () => {
  it("fica desabilitado por padrão e não faz chamada", async () => {
    const f = fakeImageFetch();
    const a = new NvidiaCosmosImageAdapter(async () => "nvapi-example", f);
    expect(a.models()).toEqual([]);
    await expect(a.generate(input)).rejects.toThrow(/não autorizado/);
    expect(f).not.toHaveBeenCalled();
  });
  it("chama endpoint separado de imagens e valida JPEG", async () => {
    const f = fakeImageFetch();
    const a = new NvidiaCosmosImageAdapter(async () => "nvapi-example", f);
    a.setEnabled(true);
    const r = await a.generate({ ...input, seed: 42 });
    expect(r.mime).toBe("image/jpeg");
    expect(r.paid).toBe(false);
    expect(r.data.byteLength).toBeGreaterThan(32);
    const [url, opts] = (f as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano");
    expect(JSON.parse(opts.body as string)).toMatchObject({ model_mode: "text2image", resolution: "720_1_1", seed: 42 });
  });
  it("não inventa suporte a 4:5", async () => {
    const a = new NvidiaCosmosImageAdapter(async () => "nvapi-example", fakeImageFetch());
    a.setEnabled(true);
    await expect(a.generate({ ...input, format: "4:5" })).rejects.toThrow(/não suporta 4:5/);
  });
  it("rejeita resposta 200 sem imagem", async () => {
    const a = new NvidiaCosmosImageAdapter(async () => "nvapi-example", fakeImageFetch(200, {}));
    a.setEnabled(true);
    await expect(a.generate(input)).rejects.toThrow(/b64_image/);
  });
  it("nega créditos e limite com mensagens claras", async () => {
    const a = new NvidiaCosmosImageAdapter(async () => "nvapi-example", fakeImageFetch(402));
    a.setEnabled(true);
    await expect(a.generate(input)).rejects.toThrow(/créditos/);
    const b = new NvidiaCosmosImageAdapter(async () => "nvapi-example", fakeImageFetch(429));
    b.setEnabled(true);
    await expect(b.generate(input)).rejects.toThrow(/Cota gratuita/);
  });
});

describe("NVIDIA Retriever Free Endpoints", () => {
  it("gera embeddings com campo input_type obrigatório", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [0.5, 0.7] }] }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const out = await nvidiaEmbed({} as never, "nvapi-example", "nvidia/nemotron-3.5-embed-1b", "consulta", "query", f);
    expect(out.dimensions).toBe(2);
    const [, req] = (f as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(req.body as string).input_type).toBe("query");
  });
  it("não aceita modelo arbitrário ou payload não estruturado", async () => {
    await expect(nvidiaEmbed({} as never, "nvapi-example", "malicioso", "x", "query")).rejects.toThrow(/não suportado/);
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const out = await nvidiaRerank("nvapi-example", "cliente", ["fidelidade"], f);
    expect(out).toEqual({ ok: true });
  });
});
