/** Shims de tipos para dependências sem tipos próprios. */
declare module "mammoth" {
  export interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<MammothResult>;
  export function convertToHtml(input: { buffer: Buffer } | { path: string }): Promise<MammothResult>;
}
