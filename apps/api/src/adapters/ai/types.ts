/**
 * CR IA — contratos dos adaptadores de IA.
 * Cada provedor implementa TextAdapter e/ou ImageAdapter.
 * Trocar/adicionar modelos = novo adaptador + registro. Sem refactor.
 */
import type { ChatRole, ImageFormat } from "@cr-ia/shared";

export interface ChatInputMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatInputMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** true se a chamada pode gerar custo no provedor */
  paid: boolean;
}

export interface TextAdapter {
  readonly provider: string;
  /** Modelos expostos por este adaptador (ids). */
  models(): string[];
  /** Disponibilidade real (ex.: Ollama acessível?). */
  ping(): Promise<boolean>;
  chat(opts: ChatOptions): Promise<ChatResult>;
}

export interface ImageGenOptions {
  model: string;
  prompt: string;
  negativePrompt?: string;
  format: ImageFormat;
  width: number;
  height: number;
  seed?: number;
  signal?: AbortSignal;
}

export interface ImageGenResult {
  data: Uint8Array;
  mime: string;
  model: string;
  paid: boolean;
  /** Custo real em USD informado pelo provedor (quando disponível). */
  costUsd?: number;
}

export interface ImageAdapter {
  readonly provider: string;
  models(): string[];
  ping(): Promise<boolean>;
  generate(opts: ImageGenOptions): Promise<ImageGenResult>;
}

export interface ImageEditOptions extends ImageGenOptions {
  /** Imagem original (bytes) + nome do arquivo. */
  image: Uint8Array;
  imageName: string;
}

/** Edição de imagem (upload + instrução). Implementado pela GPU externa. */
export interface ImageEditAdapter extends ImageAdapter {
  edit(opts: ImageEditOptions): Promise<ImageGenResult>;
}

export interface TranscribeOptions {
  audio: Uint8Array;
  mime: string;
  fileName: string;
  language?: string;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  text: string;
  language: string;
  durationSec: number | null;
}

export interface TranscriptionAdapter {
  readonly provider: string;
  models(): string[];
  ping(): Promise<boolean>;
  transcribe(opts: TranscribeOptions): Promise<TranscribeResult>;
}

export interface EmbedOptions {
  texts: string[];
  signal?: AbortSignal;
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
}

export interface EmbeddingsAdapter {
  readonly provider: string;
  models(): string[];
  ping(): Promise<boolean>;
  embed(opts: EmbedOptions): Promise<EmbedResult>;
}

/** Estimativa simples de tokens (aprox. 4 chars/token em PT). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
