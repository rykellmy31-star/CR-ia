/** Minimal zero-network smoke tests for the NVIDIA adapters, run with Node + TypeScript. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
let ts;
try { ts = require("typescript"); }
catch { ts = require("/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript"); }
const root = resolve(import.meta.dirname, "..");
function transpile(file, modules = {}) {
  const js = ts.transpileModule(readFileSync(resolve(root, file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const out = { exports: {} };
  const context = { require: (name) => {
    if (!(name in modules)) throw new Error(`Module not mocked: ${name}`);
    return modules[name];
  }, exports: out.exports, module: out, Buffer, AbortSignal, setTimeout, clearTimeout, Date, URL, Response, Error, Number, JSON, Uint8Array, console };
  vm.runInNewContext(js, context, { filename: file });
  return out.exports;
}
class RateLimitError extends Error {}
const validation = transpile("apps/api/src/adapters/ai/openrouter-image.ts", {
  "../../services/openrouter.js": { orBase: () => "", orHeaders: () => ({}) },
  "./pollinations.js": { RateLimitError },
});
const images = transpile("apps/api/src/adapters/ai/nvidia-image.ts", {
  "./openrouter-image.js": { validateImageBytes: validation.validateImageBytes },
  "./pollinations.js": { RateLimitError },
});
const retrieval = transpile("apps/api/src/services/nvidia-retrieval.ts");
const model = images.NVIDIA_COSMOS_IMAGE_ID;
const opts = { model, prompt: "Robotic arm building a car", width: 1024, height: 1024, format: "1:1" };
const jpeg = Buffer.concat([Buffer.from([255,216,255,224]),Buffer.alloc(100,24)]).toString("base64");
let calls = 0; let request;
const fakeFetch = async (url, data) => {
  calls++; request = { url, data };
  return new Response(JSON.stringify({ b64_image: jpeg }), { status: 200, headers: { "content-type": "application/json" } });
};
const a = new images.NvidiaCosmosImageAdapter(async () => "nvapi-test-key", fakeFetch);
assert.deepEqual(Array.from(a.models()), []);
await assert.rejects(a.generate(opts), /não autorizado/); assert.equal(calls, 0);
a.setEnabled(true);
const generated = await a.generate(opts);
assert.equal(generated.mime, "image/jpeg");
assert.equal(generated.paid, false);
assert.equal(generated.data.length,104);
assert.equal(request.url, "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano");
assert.equal(JSON.parse(request.data.body).model_mode,"text2image");
assert.equal(JSON.parse(request.data.body).resolution,"720_1_1");
assert.equal(request.data.headers.Authorization,"Bearer nvapi-test-key");
await assert.rejects(a.generate({...opts,format:"4:5"}),/não suporta 4:5/);
const bad = new images.NvidiaCosmosImageAdapter(async () => "nvapi-test-key",async ()=>new Response(JSON.stringify({other:1}),{status:200,headers:{"content-type":"application/json"}}));
bad.setEnabled(true);await assert.rejects(bad.generate(opts),/b64_image/);
const limited = new images.NvidiaCosmosImageAdapter(async () => "nvapi-test-key",async ()=>new Response("{}",{status:429,headers:{"retry-after":"12"}}));limited.setEnabled(true);await assert.rejects(limited.generate(opts),/Cota gratuita/);
const paid = new images.NvidiaCosmosImageAdapter(async () => "nvapi-test-key",async ()=>new Response("{}",{status:402}));paid.setEnabled(true);await assert.rejects(paid.generate(opts),/créditos/);
const f = async (url,req) => {request={url, data:req};return new Response(JSON.stringify({data:[{embedding:[0.12,0.5]}]}),{headers:{"content-type":"application/json"}})};
const v = await retrieval.nvidiaEmbed({},"nvapi-test-key","nvidia/nemotron-3.5-embed-1b","ola","query",f);
assert.equal(v.dimensions,2);assert.equal(JSON.parse(request.data.body).input_type,"query");
await assert.rejects(retrieval.nvidiaEmbed({},"key","unexpected","test","query",f),/não suportado/);
const ranking = await retrieval.nvidiaRerank("nvapi-test-key","query",["passage"],async(url,req)=> {request={url,data:req};return new Response(JSON.stringify({rankings:[1]}),{headers:{"content-type":"application/json"}})});
assert.equal(request.url,"https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-rerank-8b/reranking");
assert.deepEqual(ranking.rankings,[1]);
console.log("OK — 11 verificações de integração NVIDIA simuladas; nenhuma chamada externa.");
