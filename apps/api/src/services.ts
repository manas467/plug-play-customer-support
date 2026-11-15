import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { load } from "cheerio";
import { query, pool } from "./db.js";
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
async function assertSafeUrl(raw: string) {
  const u = new URL(raw);
  if(u.username||u.password)throw new Error("URL credentials are not allowed");
  const host=u.hostname.toLowerCase().replace(/^\[|\]$/g,"");
  const blocked=(ip:string)=>{if(ip.includes(":"))return ip==="::"||ip==="::1"||/^f[cd]/i.test(ip)||/^fe[89ab]/i.test(ip)||ip.startsWith("::ffff:");const [a,b]=ip.split(".").map(Number);return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168);};
  if(isIP(host)){if(blocked(host))throw new Error("Only public HTTP(S) URLs are allowed");}else{const ips=await lookup(host,{all:true,verbatim:true});if(!ips.length||ips.some(x=>blocked(x.address)))throw new Error("Only public HTTP(S) URLs are allowed");}
  if (!(["http:", "https:"].includes(u.protocol)) || ["localhost", "127.0.0.1", "::1"].includes(u.hostname) || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) throw new Error("Only public HTTP(S) URLs are allowed");
}
export async function readUrl(url: string) {
  await assertSafeUrl(url);
  const response = await fetch(url, { redirect:"error", signal: AbortSignal.timeout(12000), headers: { "User-Agent": "SupportPlatformBot/0.1" } });
  if (!response.ok) throw new Error(`URL returned HTTP ${response.status}`);
  if(Number(response.headers.get("content-length")??0)>5_000_000)throw new Error("URL content is too large");
  const reader=response.body?.getReader();if(!reader)throw new Error("URL returned no content");const parts:Uint8Array[]=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>5_000_000){await reader.cancel();throw new Error("URL content is too large");}parts.push(value);}
  const html=Buffer.concat(parts).toString("utf8"); const $ = load(html);
  $("script, style, nav, footer, header, noscript, svg").remove();
  const title = $("title").first().text().trim() || url;
  return { title, text: $("main").text() || $("article").text() || $("body").text() };
}
export function chunkText(text: string, size = 900, overlap = 120): string[] {
  if(text.length>2_000_000)throw new Error("Source content exceeds the 2 MB indexing limit");
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
  const res = await fetch(`${process.env.ML_SERVICE_URL ?? "http://localhost:8000"}/embed`, { method: "POST", headers: { "content-type": "application/json", ...(process.env.ML_API_KEY ? { "x-ml-api-key": process.env.ML_API_KEY } : {}) }, body: JSON.stringify({ texts, input_type: inputType }), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Embedding service error: ${await res.text()}`);
  return (await res.json() as { embeddings: number[][] }).embeddings;
}
export async function indexSource(sourceId: string, workspaceId: string, text: string) {
  await query("UPDATE sources SET status='processing', error=NULL, updated_at=now() WHERE id=$1 AND workspace_id=$2", [sourceId, workspaceId]);
  try {
    const chunks = chunkText(text); if (!chunks.length) throw new Error("No readable text found");
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += 12) {
      vectors.push(...await embed(chunks.slice(i, i + 12)));
    }
    const client=await pool.connect();
    try{await client.query("BEGIN");await client.query("DELETE FROM source_chunks WHERE source_id=$1 AND workspace_id=$2",[sourceId,workspaceId]);
      for(let i=0;i<chunks.length;i++)await client.query("INSERT INTO source_chunks(workspace_id,source_id,chunk_index,content,embedding) VALUES($1,$2,$3,$4,$5::vector)",[workspaceId,sourceId,i,chunks[i],`[${vectors[i].join(",")}]`]);
      await client.query("UPDATE sources SET status='ready',error=NULL,updated_at=now() WHERE id=$1 AND workspace_id=$2",[sourceId,workspaceId]);await client.query("COMMIT");
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  } catch (e) { await query("UPDATE sources SET status='error',error=$3,updated_at=now() WHERE id=$1 AND workspace_id=$2", [sourceId,workspaceId,String(e).slice(0,500)]); throw e; }
}
