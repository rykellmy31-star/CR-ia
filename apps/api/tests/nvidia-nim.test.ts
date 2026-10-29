import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { NvidiaNimTextAdapter, nvidiaId, actualNvidiaId } from "../src/adapters/ai/nvidia-nim.js";
import { normalizeNvidiaModels, discoverNvidia } from "../src/services/nvidia.js";
import type { Env } from "../src/types.js";

let server: Server;
let base = "";
let lastModel = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer nvapi-test-key") {
        res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized" })); return;
      }
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "nvidia/test-chat" }, { id: "nvidia/test-chat" }, { id: "invalid path" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (c) => body += c);
        req.on("end", () => {
          lastModel = JSON.parse(body).model;
          res.end(JSON.stringify({ choices: [{ message: { content: "funcionando" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
        });
        return;
      }
      res.statusCode = 404; res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
      resolve();
    });
  });
});
afterAll(() => server?.close());

describe("NVIDIA NIM seguro", () => {
  it("descobre candidatos sem inferência nem ativação", async () => {
    const stored = new Map<string, string>();
    const fakeDb = {
      getSetting: async (key: string) => stored.get(key) ?? null,
      setSetting: async (key: string, value: string) => { stored.set(key, value); },
    };
    const cat = await discoverNvidia({ JWT_SECRET: "x", NVIDIA_BASE_URL: base } as Env, fakeDb as never, "nvapi-test-key");
    expect(cat.models).toEqual(["nvidia/test-chat"]);
    expect(stored.has("nvidia.approved")).toBe(false);
  });
  it("mantém IDs de modelos isolados do OpenRouter", () => {
    expect(nvidiaId("nvidia/test-chat")).toBe("nvidia-nim:nvidia/test-chat");
    expect(actualNvidiaId("nvidia-nim:nvidia/test-chat")).toBe("nvidia/test-chat");
    expect(() => actualNvidiaId("outra-coisa")).toThrow();
    expect(normalizeNvidiaModels([{ id: "no slash" }, { id: "nvidia/good" }])).toEqual(["nvidia/good"]);
  });
  it("exige aprovação e não envia prefixo à API", async () => {
    const a = new NvidiaNimTextAdapter({ provider: "nvidia", baseUrl: base, models: [], getKey: async () => "nvapi-test-key", keyLabel: "NVIDIA" });
    expect(await a.ping()).toBe(true);
    await expect(a.chat({ model: nvidiaId("nvidia/test-chat"), messages: [{ role: "user", content: "Olá" }] })).rejects.toThrow(/autorizado/);
    a.setModels([nvidiaId("nvidia/test-chat")]);
    const r = await a.chat({ model: nvidiaId("nvidia/test-chat"), messages: [{ role: "user", content: "Olá" }] });
    expect(r.text).toBe("funcionando");
    expect(lastModel).toBe("nvidia/test-chat");
    expect(r.paid).toBe(false);
  });
});
