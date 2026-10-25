import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { load } from "cheerio";
import { query } from "./db.js";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const uploadRoot = path.resolve(process.env.UPLOAD_DIR ?? "./data/uploads");
export const storage = {
  async save(workspaceId: string, file: Express.Multer.File) {
    const dir = path.join(uploadRoot, workspaceId); await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${path.basename(file.originalname)}`);
    await fs.rename(file.path, dest); return dest;
  },
  async remove(filePath?: string) { if (filePath) await fs.rm(filePath, { force: true }); }
};
export async function extractFile(filePath: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === ".pdf") return (await pdfParse(await fs.readFile(filePath))).text;
  if (ext === ".docx") { const mammoth = await import("mammoth"); return (await mammoth.extractRawText({ path: filePath })).value; }
  if ([".txt", ".md", ".csv"].includes(ext)) return fs.readFile(filePath, "utf8");
  throw new Error("Supported files: PDF, DOCX, TXT, MD, CSV");
}
function assertSafeUrl(raw: string) {
  const u = new URL(raw);
  if (!(["http:", "https:"].includes(u.protocol)) || ["localhost", "127.0.0.1", "::1"].includes(u.hostname) || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) throw new Error("Only public HTTP(S) URLs are allowed");
}
export async function readUrl(url: string) {
  assertSafeUrl(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "SupportPlatformBot/0.1" } });
  if (!response.ok) throw new Error(`URL returned HTTP ${response.status}`);
  const html = await response.text(); const $ = load(html);
  $("script, style, nav, footer, header, noscript, svg").remove();
  const title = $("title").first().text().trim() || url;
  return { title, text: $("main").text() || $("article").text() || $("body").text() };
}
export function chunkText(text: string, size = 900, overlap = 120): string[] {
  const normalized = text.replace(/\s+/g, " ").trim(); if (!normalized) return [];
  const chunks: string[] = []; let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) { const boundary = normalized.lastIndexOf(". ", end); if (boundary > start + size * 0.6) end = boundary + 1; }
    chunks.push(normalized.slice(start, end).trim()); if (end >= normalized.length) break; start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}
export async function embed(texts: string[], inputType: "query" | "passage" = "passage"): Promise<number[][]> {
  const res = await fetch(`${process.env.ML_SERVICE_URL ?? "http://localhost:8000"}/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts, input_type: inputType }), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Embedding service error: ${await res.text()}`);
  return (await res.json() as { embeddings: number[][] }).embeddings;
}
export async function indexSource(sourceId: string, workspaceId: string, text: string) {
  await query("UPDATE sources SET status='processing', error=NULL, updated_at=now() WHERE id=$1 AND workspace_id=$2", [sourceId, workspaceId]);
  try {
    const chunks = chunkText(text); if (!chunks.length) throw new Error("No readable text found");
    await query("DELETE FROM source_chunks WHERE source_id=$1 AND workspace_id=$2", [sourceId, workspaceId]);
    for (let i = 0; i < chunks.length; i += 12) {
      const batch = chunks.slice(i, i + 12); const vectors = await embed(batch);
      for (let j = 0; j < batch.length; j++) await query("INSERT INTO source_chunks(workspace_id,source_id,chunk_index,content,embedding) VALUES($1,$2,$3,$4,$5::vector)", [workspaceId, sourceId, i + j, batch[j], `[${vectors[j].join(",")}]`]);
    }
    await query("UPDATE sources SET status='ready',updated_at=now() WHERE id=$1 AND workspace_id=$2", [sourceId,workspaceId]);
  } catch (e) { await query("UPDATE sources SET status='error',error=$3,updated_at=now() WHERE id=$1 AND workspace_id=$2", [sourceId,workspaceId,String(e).slice(0,500)]); throw e; }
}
