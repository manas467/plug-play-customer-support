import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { query, pool } from "./db.js";
import { embed, extractFile, indexSource, readUrl, storage } from "./services.js";
const app = express(); const port = Number(process.env.API_PORT ?? 4000);
const jwtSecret = process.env.JWT_SECRET ?? "local-only-change-this-secret-before-deploy";
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: true, credentials: false })); app.use(express.json({ limit: "2mb" }));
app.use("/api/widget", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./data/uploads");
const upload = multer({ dest: path.join(uploadDir, "tmp"), limits: { fileSize: 15 * 1024 * 1024 } });
type AuthReq = express.Request & { user?: { id: string; email: string } };
function tokenFor(user: { id: string; email: string }) { return jwt.sign(user, jwtSecret, { expiresIn: "12h" }); }
function auth(req: AuthReq, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  try { if (!token) throw new Error(); req.user = jwt.verify(token, jwtSecret) as { id: string; email: string }; next(); }
  catch { res.status(401).json({ error: "Sign in required" }); }
}
async function workspace(req: AuthReq, res: express.Response, next: express.NextFunction) {
  const id = req.header("x-workspace-id");
  if (!id || !req.user) return res.status(400).json({ error: "x-workspace-id is required" });
  const result = await query<{role:string}>("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2", [id, req.user.id]);
  if (!result.rowCount) return res.status(403).json({ error: "Workspace access denied" });
  (req as any).workspaceId = id; (req as any).role = result.rows[0].role; next();
}
function requireRole(...roles: string[]) { return (req: AuthReq, res: express.Response, next: express.NextFunction) => roles.includes((req as any).role) ? next() : res.status(403).json({error:"Insufficient workspace role"}); }
function errorHandler(err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) {
  if(err instanceof z.ZodError)return res.status(400).json({error:"Validation failed",issues:err.issues});
  console.error(err); res.status(500).json({ error: err?.message ?? "Unexpected server error" });
}
app.get("/health", (_req,res)=>res.json({ok:true,service:"api"}));

app.post("/api/auth/register", async (req,res,next)=>{
  try {
    const data=z.object({name:z.string().min(1).max(100),email:z.string().email(),password:z.string().min(8)}).parse(req.body);
    const user=(await query<{id:string;email:string;name:string}>("INSERT INTO users(name,email,password_hash) VALUES($1,lower($2),$3) RETURNING id,email,name",[data.name,data.email,await bcrypt.hash(data.password,12)])).rows[0];
    const ws=(await query<{id:string;name:string;public_key:string}>("INSERT INTO workspaces(name) VALUES($1) RETURNING id,name,public_key",[`${data.name}'s workspace"])).rows[0];
    await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[ws.id,user.id]);
    res.status(201).json({token:tokenFor(user),user,workspaces:[ws]});
  } catch(e){ next(e); }
});
app.post("/api/auth/login", async(req,res,next)=>{
  try { const {email,password}=z.object({email:z.string().email(),password:z.string()}).parse(req.body);
    const r=await query<any>("SELECT id,email,name,password_hash FROM users WHERE email=lower($1)",[email]);
    if(!r.rowCount||!await bcrypt.compare(password,r.rows[0].password_hash)) return res.status(401).json({error:"Invalid email or password"});
    const user={id:r.rows[0].id,email:r.rows[0].email,name:r.rows[0].name};
    const workspaces=(await query("SELECT w.id,w.name,w.public_key,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at",[user.id])).rows;
    res.json({token:tokenFor(user),user,workspaces});
  } catch(e){next(e);}
});
app.get("/api/me",auth,async(req:AuthReq,res)=>{
  const workspaces=(await query("SELECT w.id,w.name,w.public_key,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1",[req.user!.id])).rows;
  res.json({user:req.user,workspaces});
});
app.post("/api/workspaces",auth,async(req:AuthReq,res,next)=>{
  try { const name=z.string().min(1).max(100).parse(req.body.name); const ws=(await query("INSERT INTO workspaces(name) VALUES($1) RETURNING *",[name])).rows[0]; await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[ws.id,req.user!.id]); res.status(201).json(ws); }catch(e){next(e);}
});
app.get("/api/workspaces/:id/settings",auth,async(req:AuthReq,res)=>{
 const r=await query("SELECT w.id,w.name,w.public_key,w.brand_color,w.welcome_message,w.allowed_domains,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.id=$1 AND m.user_id=$2",[req.params.id,req.user!.id]);
 if(!r.rowCount)return res.status(404).json({error:"Workspace not found"}); res.json(r.rows[0]);
});
app.patch("/api/workspaces/:id/settings",auth,async(req:AuthReq,res,next)=>{
 try {const r=await query("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",[req.params.id,req.user!.id]); if(!r.rowCount)return res.status(404).json({error:"Workspace not found"}); if(!["owner","admin"].includes(r.rows[0].role))return res.status(403).json({error:"Admin role required"});
 const d=z.object({name:z.string().min(1).max(100).optional(),brandColor:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),welcomeMessage:z.string().max(250).optional(),allowedDomains:z.array(z.string().max(253)).max(30).optional()}).parse(req.body);
 const w=(await query("UPDATE workspaces SET name=coalesce($2,name),brand_color=coalesce($3,brand_color),welcome_message=coalesce($4,welcome_message),allowed_domains=coalesce($5,allowed_domains) WHERE id=$1 RETURNING id,name,public_key,brand_color,welcome_message,allowed_domains",[req.params.id,d.name,d.brandColor,d.welcomeMessage,d.allowedDomains])).rows[0]; res.json(w);
 }catch(e){next(e);}
});
app.post("/api/workspaces/:id/members",auth,async(req:AuthReq,res,next)=>{
 try {const role=(await query<any>("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",[req.params.id,req.user!.id])).rows[0]?.role; if(!["owner","admin"].includes(role))return res.status(403).json({error:"Admin role required"}); const d=z.object({email:z.string().email(),role:z.enum(["admin","agent"])}).parse(req.body); const u=(await query<any>("SELECT id,email,name FROM users WHERE email=lower($1)",[d.email])).rows[0]; if(!u)return res.status(404).json({error:"User must register before being added"}); await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role",[req.params.id,u.id,d.role]); res.status(201).json({user:u,role:d.role}); }catch(e){next(e);}
});
app.get("/api/workspaces/:id/members",auth,async(req:AuthReq,res)=>{const allowed=await query("SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",[req.params.id,req.user!.id]);if(!allowed.rowCount)return res.status(404).json({error:"Workspace not found"});res.json((await query("SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.role,u.name",[req.params.id])).rows);});

app.get("/api/sources",auth,workspace,async(req,res)=>res.json((await query("SELECT id,title,kind,original_name,url,status,error,created_at,updated_at,(SELECT count(*) FROM source_chunks c WHERE c.source_id=s.id) chunk_count FROM sources s WHERE workspace_id=$1 ORDER BY created_at DESC",[(req as any).workspaceId])).rows));
app.post("/api/sources/faq",auth,workspace,requireRole("owner","admin"),async(req,res,next)=>{
 try {const d=z.object({question:z.string().min(3).max(2000),answer:z.string().min(2).max(8000),title:z.string().min(1).max(200).optional()}).parse(req.body); const ws=(req as any).workspaceId; const title=d.title??d.question.slice(0,100); const source=(await query("INSERT INTO sources(workspace_id,title,kind,status) VALUES($1,$2,'faq','processing') RETURNING id,title,kind,status",[ws,title])).rows[0]; await indexSource(source.id,ws,`Question: ${d.question}\nAnswer: ${d.answer}`); res.status(201).json({...source,status:"ready"}); }catch(e){next(e);}
});
app.post("/api/sources/url",auth,workspace,requireRole("owner","admin"),async(req,res,next)=>{
 try {const {url}=z.object({url:z.string().url()}).parse(req.body); const ws=(req as any).workspaceId; const page=await readUrl(url); const s=(await query("INSERT INTO sources(workspace_id,title,kind,url,status) VALUES($1,$2,'url',$3,'processing') RETURNING id,title,kind,url,status",[ws,page.title,url])).rows[0]; await indexSource(s.id,ws,page.text);res.status(201).json({...s,status:"ready"});}catch(e){next(e);}
});
app.post("/api/sources/file",auth,workspace,requireRole("owner","admin"),upload.single("file"),async(req,res,next)=>{
 let saved="",sourceId=""; try {if(!req.file) return res.status(400).json({error:"file is required"}); const ws=(req as any).workspaceId; const ext=path.extname(req.file.originalname).toLowerCase(); if(![".pdf",".docx",".txt",".md",".csv"].includes(ext)){await fs.rm(req.file.path,{force:true});return res.status(400).json({error:"Supported file types: PDF, DOCX, TXT, MD, CSV"});}
 saved=await storage.save(ws,req.file); const source=(await query("INSERT INTO sources(workspace_id,title,kind,original_name,storage_path,status) VALUES($1,$2,'file',$3,$4,'processing') RETURNING id,title,kind,status",[ws,path.basename(req.file.originalname,ext),req.file.originalname,saved])).rows[0];sourceId=source.id; const text=await extractFile(saved,req.file.originalname); await indexSource(source.id,ws,text); res.status(201).json({...source,status:"ready"});
 }catch(e){if(sourceId)await query("UPDATE sources SET status='error',error=$2,updated_at=now() WHERE id=$1",[sourceId,String(e).slice(0,500)]).catch(()=>{});if(req.file)await fs.rm(req.file.path,{force:true}).catch(()=>{});next(e);}
});
app.delete("/api/sources/:id",auth,workspace,requireRole("owner","admin"),async(req,res)=>{const source=await query<any>("DELETE FROM sources WHERE id=$1 AND workspace_id=$2 RETURNING storage_path",[req.params.id,(req as any).workspaceId]);if(source.rows[0]?.storage_path)await storage.remove(source.rows[0].storage_path);res.status(204).end();});

app.get("/api/conversations",auth,workspace,async(req,res)=>{
 const status=typeof req.query.status==="string"?req.query.status:"all"; const result=await query("SELECT c.id,c.visitor_id,c.customer_name,c.customer_email,c.status,c.created_at,c.updated_at,(SELECT content FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) last_message,(SELECT count(*) FROM messages WHERE conversation_id=c.id) message_count FROM conversations c WHERE workspace_id=$1 AND ($2='all' OR status=$2) ORDER BY updated_at DESC LIMIT 200",[(req as any).workspaceId,status]);res.json(result.rows);
});
app.get("/api/conversations/:id/messages",auth,workspace,async(req,res)=>{const owned=await query("SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2",[req.params.id,(req as any).workspaceId]);if(!owned.rowCount)return res.status(404).json({error:"Conversation not found"});res.json((await query("SELECT id,sender,content,language,citations,handoff,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at",[req.params.id])).rows);});
app.post("/api/conversations/:id/reply",auth,workspace,requireRole("owner","admin","agent"),async(req,res,next)=>{try{const content=z.string().min(1).max(8000).parse(req.body.content);const own=await query("SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2",[req.params.id,(req as any).workspaceId]);if(!own.rowCount)return res.status(404).json({error:"Conversation not found"});const m=(await query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'agent',$2) RETURNING *",[req.params.id,content])).rows[0];await query("UPDATE conversations SET status='open',updated_at=now() WHERE id=$1",[req.params.id]);res.status(201).json(m);}catch(e){next(e);}});
app.patch("/api/conversations/:id",auth,workspace,async(req,res)=>{const status=z.enum(["open","escalated","closed"]).safeParse(req.body.status);if(!status.success)return res.status(400).json({error:"Invalid status"});const r=await query("UPDATE conversations SET status=$3,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING id,status",[req.params.id,(req as any).workspaceId,status.data]);if(!r.rowCount)return res.status(404).json({error:"Conversation not found"});res.json(r.rows[0]);});
app.post("/api/feedback",auth,workspace,async(req,res,next)=>{try{const d=z.object({messageId:z.string().uuid(),helpful:z.boolean(),comment:z.string().max(1000).optional()}).parse(req.body);const r=await query("INSERT INTO feedback(workspace_id,message_id,helpful,comment) SELECT $1,m.id,$3,$4 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$2 AND m.sender='assistant' AND c.workspace_id=$1 ON CONFLICT(message_id) DO UPDATE SET helpful=excluded.helpful,comment=excluded.comment RETURNING *",[(req as any).workspaceId,d.messageId,d.helpful,d.comment]);if(!r.rowCount)return res.status(404).json({error:"Assistant message not found"});res.status(201).json(r.rows[0]);}catch(e){next(e);}});
app.get("/api/feedback",auth,workspace,async(req,res)=>res.json((await query("SELECT f.id,f.message_id,f.helpful,f.comment,f.created_at,c.id conversation_id FROM feedback f JOIN messages m ON m.id=f.message_id JOIN conversations c ON c.id=m.conversation_id WHERE f.workspace_id=$1 ORDER BY f.created_at DESC LIMIT 200",[(req as any).workspaceId])).rows));

async function widgetWorkspace(req:express.Request,res:express.Response,bootstrap=false){
 const key=req.params.key;const w=(await query<any>("SELECT id,public_key,brand_color,welcome_message,allowed_domains FROM workspaces WHERE public_key=$1",[key])).rows[0];if(!w){res.status(404).json({error:"Widget not found"});return null;}
 let origin=req.get("origin")??"";
 if(bootstrap){if(!origin){res.status(403).json({error:"A website origin is required"});return null;}}
 else {const raw=req.header("authorization")?.replace(/^Bearer\s+/i,"");try{const token=jwt.verify(raw??"",jwtSecret) as any;if(token.type!=="widget"||token.publicKey!==key||token.workspaceId!==w.id)throw new Error();origin=token.origin;}catch{res.status(401).json({error:"Valid widget session required"});return null;}}
 if(w.allowed_domains.length){let host="";try{host=new URL(origin).hostname.toLowerCase();}catch{} const allowed=w.allowed_domains.some((d:string)=>host===d.toLowerCase()||host.endsWith(`.${d.toLowerCase()}`));if(!allowed){res.status(403).json({error:"This website is not allowed to use the widget"});return null;}}
 return w;
}
app.get("/api/widget/:key/bootstrap",async(req,res)=>{const w=await widgetWorkspace(req,res,true);if(!w)return;const name=(await query<any>("SELECT name FROM workspaces WHERE id=$1",[w.id])).rows[0]?.name;const token=jwt.sign({type:"widget",workspaceId:w.id,publicKey:w.public_key,origin:req.get("origin")},jwtSecret,{expiresIn:"2h"});res.json({token,config:{workspaceId:w.id,workspaceName:name,brandColor:w.brand_color,welcomeMessage:w.welcome_message}});});
app.get("/api/widget/:key/config",async(req,res)=>{const w=await widgetWorkspace(req,res);if(w)res.json({workspaceId:w.id,workspaceName:(await query<any>("SELECT name FROM workspaces WHERE id=$1",[w.id])).rows[0]?.name,brandColor:w.brand_color,welcomeMessage:w.welcome_message});});
app.post("/api/widget/:key/conversations",async(req,res,next)=>{try{const w=await widgetWorkspace(req,res);if(!w)return;const visitorId=z.string().min(8).max(100).parse(req.body.visitorId);const info=z.object({name:z.string().max(100).optional(),email:z.string().email().optional()}).safeParse(req.body);let c=(await query("SELECT id,status,created_at FROM conversations WHERE workspace_id=$1 AND visitor_id=$2 AND status <> 'closed' ORDER BY updated_at DESC LIMIT 1",[w.id,visitorId])).rows[0];if(!c)c=(await query("INSERT INTO conversations(workspace_id,visitor_id,customer_name,customer_email) VALUES($1,$2,$3,$4) RETURNING id,status,created_at",[w.id,visitorId,info.success?info.data.name:null,info.success?info.data.email:null])).rows[0];res.status(201).json({conversation:c,workspace:{brandColor:w.brand_color,welcomeMessage:w.welcome_message}});}catch(e){next(e);}});
app.get("/api/widget/:key/conversations/:id/messages",async(req,res)=>{const w=await widgetWorkspace(req,res);if(!w)return;const c=await query("SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2 AND visitor_id=$3",[req.params.id,w.id,req.query.visitorId]);if(!c.rowCount)return res.status(404).json({error:"Conversation not found"});res.json((await query("SELECT id,sender,content,language,citations,handoff,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at",[req.params.id])).rows);});
app.post("/api/widget/:key/conversations/:id/messages",async(req,res,next)=>{
 try{
  const w=await widgetWorkspace(req,res);if(!w)return;const d=z.object({visitorId:z.string().min(8).max(100),content:z.string().min(1).max(4000)}).parse(req.body);
  const c=await query("SELECT id,status FROM conversations WHERE id=$1 AND workspace_id=$2 AND visitor_id=$3",[req.params.id,w.id,d.visitorId]);if(!c.rowCount)return res.status(404).json({error:"Conversation not found"});
  await query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'customer',$2)",[req.params.id,d.content]);await query("UPDATE conversations SET status='open' WHERE id=$1 AND status='closed'",[req.params.id]);
  const vector=(await embed([d.content],"query"))[0];const vec=`[${vector.join(",")}]`;
  const matches=(await query<any>("SELECT x.source_id,x.title,x.content,x.url,x.page,x.score FROM (SELECT s.id source_id,s.title,s.url,c.page,c.content,1-(c.embedding <=> $2::vector) score,ts_rank(c.search_vector,websearch_to_tsquery('simple',$3)) fts FROM source_chunks c JOIN sources s ON s.id=c.source_id WHERE c.workspace_id=$1 AND s.status='ready') x ORDER BY (x.score*0.75 + least(x.fts,1)*0.25) DESC LIMIT 5",[w.id,vec,d.content])).rows;
  const wantsStream=(req.get("accept")??"").includes("text/event-stream");
  const fallback="I am not confident I can answer that from this business's help information. I have sent it to the support team so they can help.";
  let answer=fallback;let language=/[\u0900-\u097f]/.test(d.content)?"hi":"en";let handoff=matches.length===0||Number(matches[0].score)<0.23;let citations:any[]=[];let partial="";
  if(wantsStream){res.status(200);res.setHeader("Content-Type","text/event-stream; charset=utf-8");res.setHeader("Cache-Control","no-cache, no-transform");res.setHeader("Connection","keep-alive");res.flushHeaders?.();}
  const emit=(data:any)=>{if(wantsStream)res.write(`data: ${JSON.stringify(data)}\n\n`);};
  if(!handoff){
   const context=matches.map((m:any,i:number)=>`[${i+1}] ${m.title}${m.page?` (page ${m.page})`:""}\n${m.content}`).join("\n\n");
   const mlUrl=process.env.ML_SERVICE_URL??"http://localhost:8000";const body=JSON.stringify({question:d.content,language,context,model:process.env.OLLAMA_CHAT_MODEL??"qwen2.5:1.5b"});
   if(wantsStream){
    const mr=await fetch(`${mlUrl}/generate-stream`,{method:"POST",headers:{"content-type":"application/json"},body,signal:AbortSignal.timeout(180000)});if(!mr.ok)throw new Error(`Model service error: ${await mr.text()}`);
    const reader=mr.body!.getReader();const decoder=new TextDecoder();let buffer="";let early="";let shouldStream=true;
    while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop()??"";for(const line of lines){if(!line.startsWith("data: "))continue;const event=JSON.parse(line.slice(6));if(event.error)throw new Error(event.error);if(event.token){partial+=event.token;if(shouldStream){early+=event.token;if(early.length>=9){emit({type:"delta",token:early});early="";}if(/^\s*(handoff|escalate)/i.test(partial))shouldStream=false;else if(early.length) {emit({type:"delta",token:early});early="";}}}}}
   }else{const mr=await fetch(`${mlUrl}/generate`,{method:"POST",headers:{"content-type":"application/json"},body,signal:AbortSignal.timeout(180000)});if(!mr.ok)throw new Error(`Model service error: ${await mr.text()}`);partial=(await mr.json() as {answer:string}).answer;}
   const generated=partial.trim();const nums=[...generated.matchAll(/\[(\d+)\]/g)].map(x=>Number(x[1]));const clean=generated.replace(/\s*\[\d+\]/g,"").trim();
   for(const n of [...new Set(nums)]){const m=matches[n-1];if(m)citations.push({sourceId:m.source_id,title:m.title,excerpt:m.content.slice(0,280),url:m.url??undefined,page:m.page??undefined});}
   if(/^\s*(handoff|escalate)\b/i.test(clean)||!clean||!citations.length){handoff=true;}
   else answer=clean;
  }
  if(handoff){answer=language==="hi"?"à¤®à¥à¤à¥‡ à¤‰à¤ªà¤²à¤¬à¥à¤§ à¤¸à¤¹à¤¾à¤¯à¤¤à¤¾ à¤œà¤¾à¤¨à¤•à¤¾à¤°à¥€ à¤®à¥‡à¤‚ à¤‡à¤¸à¤•à¤¾ à¤­à¤°à¥‹à¤¸à¥‡à¤®à¤‚à¤¦ à¤‰à¤¤à¥à¤¤à¤° à¤¨à¤¹à¥€à¤‚ à¤®à¤¿à¤²à¤¾à¥¤ à¤®à¥ˆà¤‚à¤¨à¥‡ à¤†à¤ªà¤•à¤¾ à¤¸à¤‚à¤¦à¥‡à¤¶ à¤¸à¤¹à¤¾à¤¯à¤¤à¤¾ à¤Ÿà¥€à¤® à¤•à¥‹ à¤­à¥‡à¤œ à¤¦à¤¿à¤¯à¤¾ à¤¹à¥ˆà¥¤":fallback;citations=[];}
  const m=(await query("INSERT INTO messages(conversation_id,sender,content,language,citations,handoff) VALUES($1,'assistant',$2,$3,$4::jsonb,$5) RETURNING id,sender,content,language,citations,handoff,created_at",[req.params.id,answer,language,JSON.stringify(citations),handoff])).rows[0];
  await query("UPDATE conversations SET status=CASE WHEN $2 THEN 'escalated' ELSE status END,updated_at=now() WHERE id=$1",[req.params.id,handoff]);
  if(wantsStream){emit({type:"final",message:m});res.write("data: {\"type\":\"done\"}\n\n");res.end();}else res.status(201).json(m);
 }catch(e){if(res.headersSent){res.write(`data: ${JSON.stringify({type:"error",error:(e as Error).message})}\n\n`);res.end();}else next(e);}
});
app.post("/api/widget/:key/conversations/:id/escalate",async(req,res,next)=>{try{const w=await widgetWorkspace(req,res);if(!w)return;const d=z.object({visitorId:z.string().min(8).max(100),message:z.string().max(1000).optional()}).parse(req.body);const c=await query("SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2 AND visitor_id=$3",[req.params.id,w.id,d.visitorId]);if(!c.rowCount)return res.status(404).json({error:"Conversation not found"});if(d.message)await query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'customer',$2)",[req.params.id,d.message]);await query("UPDATE conversations SET status='escalated',updated_at=now() WHERE id=$1",[req.params.id]);const m=(await query("INSERT INTO messages(conversation_id,sender,content,handoff) VALUES($1,'system','A customer requested a human support agent.',true) RETURNING id,sender,content,handoff,created_at",[req.params.id])).rows[0];res.status(201).json(m);}catch(e){next(e);}});
app.post("/api/widget/:key/messages/:messageId/feedback",async(req,res,next)=>{try{const w=await widgetWorkspace(req,res);if(!w)return;const d=z.object({visitorId:z.string().min(8).max(100),helpful:z.boolean()}).parse(req.body);const r=await query("INSERT INTO feedback(workspace_id,message_id,helpful) SELECT $1,m.id,$4 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$2 AND m.sender='assistant' AND c.workspace_id=$1 AND c.visitor_id=$3 ON CONFLICT(message_id) DO UPDATE SET helpful=excluded.helpful RETURNING id,message_id,helpful",[w.id,req.params.messageId,d.visitorId,d.helpful]);if(!r.rowCount)return res.status(404).json({error:"Assistant message not found"});res.status(201).json(r.rows[0]);}catch(e){next(e);}});
app.use(errorHandler);

async function seed(){
 await pool.query("SELECT 1");
 const email=process.env.DEMO_EMAIL;const password=process.env.DEMO_PASSWORD;
 if(email&&password){const existing=await query<any>("SELECT id FROM users WHERE email=lower($1)",[email]);if(!existing.rowCount){const u=(await query<any>("INSERT INTO users(name,email,password_hash) VALUES('Demo Admin',lower($1),$2) RETURNING id",[email,await bcrypt.hash(password,12)])).rows[0];const w=(await query<any>("INSERT INTO workspaces(name,allowed_domains) VALUES('Acme Demo Support',ARRAY['localhost']) RETURNING id",[])).rows[0];await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[w.id,u.id]);const faq=(await query<any>("INSERT INTO sources(workspace_id,title,kind,status) VALUES($1,'Getting started','faq','ready') RETURNING id",[w.id])).rows[0];const text="Question: How do I reset my password? Answer: Select Forgot password on the sign-in screen, enter your account email, and follow the secure reset link sent to your inbox. The link expires after 30 minutes.\n\nQuestion: How can I contact support? Answer: Ask a question through this support chat. If the assistant cannot find a reliable answer, it will pass your conversation to a support agent.";const chunks=text.match(/.{1,900}/gs)??[text];const vectors=await embed(chunks);for(let i=0;i<chunks.length;i++)await query("INSERT INTO source_chunks(workspace_id,source_id,chunk_index,content,embedding) VALUES($1,$2,$3,$4,$5::vector)",[w.id,faq.id,i,chunks[i],`[${vectors[i].join(",")}]`]);}}
}
seed().then(()=>app.listen(port,()=>console.log(`API listening on http://localhost:${port}`))).catch(e=>{console.error("Startup failed",e);process.exit(1);});
