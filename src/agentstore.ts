/**
 * What the agent keeps: its own files (notes, personality, a folder per
 * chat), its sessions and their messages, and the log of every change it
 * makes. The tables are in `db.ts` (layout 3).
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError, newId } from "./errors.ts";
import type { AgentEdit, AgentMessage, AgentSession, ApiToolCall } from "./types.ts";

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

/** The files a new agent starts with. Both are yours to rewrite. */
export const STARTING_FILES: Record<string, string> = {
  "index.md": `# Notes

The agent reads this file at the start of every conversation. Keep here what it should always know: how you like to work, what you're working on now, and decisions already made.
`,
  "personality.md": `# Personality

You help write and tune roleplay in Anoesia: the cards, the prompts, and the chats themselves. Talk plainly and briefly, like a collaborator at the same desk. When you think something won't work, say so and say why.
`,
};

/** The starting personality of a chat's own agent. */
export function chatPersonality(chatName: string): string {
  return `# Personality

You are the agent for the chat "${chatName}". You know this story closely: its cast, what has happened, and the notebook you keep for it. Help with this chat first; the rest of Anoesia is there when it's needed. Talk plainly and briefly, and say when you think something won't work, and why.
`;
}

/** Where a file's path may not go: outside the folder, or empty parts. */
export function cleanFilePath(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("A file's path must be text.");
  const parts = raw.trim().replace(/\\/g, "/").split("/").filter((p) => p !== "");
  if (parts.length === 0) throw new ValidationError("A file needs a name.");
  if (parts.some((p) => p === "." || p === "..")) throw new ValidationError("A file's path can't use . or .. parts.");
  if (parts.some((p) => p.length > 200)) throw new ValidationError("Each part of a file's path must be under 200 characters.");
  return parts.join("/");
}

export interface AgentFile {
  path: string;
  content: string;
  updatedAt: string;
}

export class AgentStore {
  constructor(readonly db: Database) {
    // Seed the starting files the first time.
    const count = (db.query("SELECT COUNT(*) AS n FROM agent_files").get() as { n: number }).n;
    if (count === 0) for (const [path, content] of Object.entries(STARTING_FILES)) this.writeFile(path, content);
  }

  // --------------------------------------------------------------- files

  files(): AgentFile[] {
    return (this.db.query("SELECT * FROM agent_files ORDER BY path").all() as Row[]).map(toFile);
  }

  file(path: string): AgentFile | null {
    const row = this.db.query("SELECT * FROM agent_files WHERE path = ?").get(path) as Row | null;
    return row ? toFile(row) : null;
  }

  writeFile(rawPath: unknown, content: unknown): AgentFile {
    const path = cleanFilePath(rawPath);
    if (typeof content !== "string") throw new ValidationError("A file's text must be text.");
    if (this.files().some((f) => f.path.startsWith(path + "/"))) throw new ValidationError(`${path} is a folder.`);
    const parent = path.split("/").slice(0, -1);
    for (let i = 1; i <= parent.length; i++) {
      if (this.file(parent.slice(0, i).join("/"))) throw new ValidationError(`${parent.slice(0, i).join("/")} is a file, so it can't hold others.`);
    }
    this.db
      .query("INSERT INTO agent_files (path, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at")
      .run(path, content, now());
    return this.file(path)!;
  }

  deleteFile(path: string): void {
    if (!this.file(path)) throw new NotFoundError("file");
    this.db.query("DELETE FROM agent_files WHERE path = ?").run(path);
  }

  // ------------------------------------------------------------ sessions

  sessions(): AgentSession[] {
    return (this.db.query("SELECT * FROM agent_sessions ORDER BY updated_at DESC").all() as Row[]).map(toSession);
  }

  /** A chat's agent starts with its own personality file, which you can rewrite. */
  ensureChatFiles(chatId: string, chatName: string): void {
    const path = `chats/${chatId}/personality.md`;
    if (!this.file(path)) this.writeFile(path, chatPersonality(chatName));
  }

  session(id: string): AgentSession {
    const row = this.db.query("SELECT * FROM agent_sessions WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFoundError("agent session");
    return toSession(row);
  }

  createSession(raw: Row): AgentSession {
    const id = newId();
    const at = now();
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 200) : "New session";
    const scope = raw.scope === "chat" ? "chat" : "main";
    const chatId = this.chatIdOf(raw.chatId);
    if (scope === "chat" && !chatId) throw new ValidationError("A chat's agent needs a chat. Open one first.");
    this.db.query("INSERT INTO agent_sessions (id, title, scope, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, title, scope, chatId, at, at);
    if (scope === "chat") {
      const name = (this.db.query("SELECT name FROM chats WHERE id = ?").get(chatId) as { name: string }).name;
      this.ensureChatFiles(chatId!, name);
    }
    return this.session(id);
  }

  updateSession(id: string, raw: Row): AgentSession {
    const s = this.session(id);
    const title = raw.title !== undefined ? (typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 200) : s.title) : s.title;
    // A chat's agent stays with its chat; the main agent follows the open one.
    const chatId = s.scope === "chat" ? s.chatId : raw.chatId !== undefined ? this.chatIdOf(raw.chatId) : s.chatId;
    this.db.query("UPDATE agent_sessions SET title = ?, chat_id = ?, updated_at = ? WHERE id = ?").run(title, chatId, now(), id);
    return this.session(id);
  }

  deleteSession(id: string): void {
    this.session(id);
    this.db.query("DELETE FROM agent_sessions WHERE id = ?").run(id);
  }

  private chatIdOf(raw: unknown): string | null {
    if (typeof raw !== "string" || !raw) return null;
    return this.db.query("SELECT id FROM chats WHERE id = ?").get(raw) ? raw : null;
  }

  // ------------------------------------------------------------ messages

  messages(sessionId: string): AgentMessage[] {
    return (this.db.query("SELECT * FROM agent_messages WHERE session_id = ? ORDER BY seq").all(sessionId) as Row[]).map(toMessage);
  }

  addMessage(input: { sessionId: string; turnId: string; role: AgentMessage["role"]; content: string; toolCalls?: ApiToolCall[]; toolCallId?: string; toolName?: string }): AgentMessage {
    const id = newId();
    const seq = (this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM agent_messages WHERE session_id = ?").get(input.sessionId) as { n: number }).n;
    this.db
      .query("INSERT INTO agent_messages (id, session_id, seq, turn_id, role, content, tool_calls, tool_call_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.sessionId, seq, input.turnId, input.role, input.content, input.toolCalls ? JSON.stringify(input.toolCalls) : null, input.toolCallId ?? null, input.toolName ?? null, now());
    this.db.query("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(now(), input.sessionId);
    return toMessage(this.db.query("SELECT * FROM agent_messages WHERE id = ?").get(id) as Row);
  }

  // ------------------------------------------------------------ edit log

  /** The newest changes first. */
  edits(filter: { sessionId?: string; turnId?: string; limit?: number } = {}): AgentEdit[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.sessionId) (where.push("session_id = ?"), args.push(filter.sessionId));
    if (filter.turnId) (where.push("turn_id = ?"), args.push(filter.turnId));
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const sql = `SELECT * FROM agent_edits ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`;
    return (this.db.query(sql).all(...args) as Row[]).map(toEdit);
  }

  edit(id: string): AgentEdit {
    const row = this.db.query("SELECT * FROM agent_edits WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFoundError("change");
    return toEdit(row);
  }

  addEdit(input: Omit<AgentEdit, "id" | "createdAt" | "revertedAt">): AgentEdit {
    const id = newId();
    this.db
      .query("INSERT INTO agent_edits (id, session_id, turn_id, path, target, before, after, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.sessionId, input.turnId, input.path, input.target, input.before, input.after, input.meta ? JSON.stringify(input.meta) : null, now());
    return this.edit(id);
  }

  markReverted(id: string): AgentEdit {
    this.db.query("UPDATE agent_edits SET reverted_at = ? WHERE id = ?").run(now(), id);
    return this.edit(id);
  }
}

function toFile(r: Row): AgentFile {
  return { path: r.path as string, content: r.content as string, updatedAt: r.updated_at as string };
}

function toSession(r: Row): AgentSession {
  return { id: r.id as string, title: r.title as string, scope: r.scope === "chat" ? "chat" : "main", chatId: (r.chat_id as string | null) ?? null, createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}

function toMessage(r: Row): AgentMessage {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnId: r.turn_id as string,
    role: r.role as AgentMessage["role"],
    content: r.content as string,
    toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls as string) as ApiToolCall[]) : null,
    toolCallId: (r.tool_call_id as string | null) ?? null,
    toolName: (r.tool_name as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toEdit(r: Row): AgentEdit {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnId: r.turn_id as string,
    path: r.path as string,
    target: r.target as string,
    before: (r.before as string | null) ?? null,
    after: (r.after as string | null) ?? null,
    meta: r.meta ? (JSON.parse(r.meta as string) as Record<string, unknown>) : null,
    createdAt: r.created_at as string,
    revertedAt: (r.reverted_at as string | null) ?? null,
  };
}
