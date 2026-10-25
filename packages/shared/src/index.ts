export type Role = "owner" | "admin" | "agent";
export type SourceStatus = "queued" | "processing" | "ready" | "error";
export type Citation = { sourceId: string; title: string; excerpt: string; url?: string; page?: number };
export type AssistantReply = { answer: string; language: string; citations: Citation[]; handoff: boolean; reason?: string };
