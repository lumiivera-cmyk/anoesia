/**
 * The agent's tools, modelled on LumiAgent's: path-based read, list, grep,
 * edit, write and delete over the workspace (`workspace.ts`), plus a prompt
 * dry run, macro check, token count, asking the person a question, notes,
 * and the edit log.
 *
 * A tool returns text for the model. A tool that fails returns text starting
 * with "Error:", so the model can read why and try again.
 */

import type { ToolSpec } from "./nanogpt.ts";
import { assemblePrompt } from "./prompt.ts";
import type { AgentEdit, PromptBlock } from "./types.ts";
import type { EditContext, Workspace } from "./workspace.ts";

export interface ToolResult {
  /** What the model sees. */
  text: string;
  /** Changes this call made (shown in the panel with a diff and a revert button). */
  edits?: AgentEdit[];
  /** The turn ends here, waiting for the person (ask_user). */
  stop?: boolean;
}

const MAX_READ = 30_000;
const MAX_HITS = 80;

const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const int = (description: string) => ({ type: "integer", description });

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

export const TOOL_SPECS: ToolSpec[] = [
  tool(
    "list",
    "List what's in a folder. Top folders: cards/, prompt/, chats/, agent/. Folders end with /. Each entry has a short note (a message's author and first words, a block's role and depth, a file's size).",
    { path: str("The folder, e.g. 'chats/Night Market/messages/'. Empty for the top.") },
  ),
  tool(
    "read",
    "Read the text at a path: a card field, the main prompt, a message, a prompt block, or one of your files. Long texts can be read a range of lines at a time.",
    {
      path: str("e.g. 'cards/Rumi Kang/Description', 'chats/Night Market/messages/12', 'agent/notes/draft.md'"),
      start_line: int("First line to read (1-based). Optional."),
      end_line: int("Last line to read. Optional."),
    },
    ["path"],
  ),
  tool(
    "grep",
    "Search texts under a path for words or a regular expression. Use it to find every message with a habit to comb out, or every mention of a detail to retcon. Returns each hit's path and the words around it.",
    {
      pattern: str("What to look for."),
      path: str("Where to search, e.g. 'chats/Night Market/messages/' or 'cards/'. Empty: everywhere."),
      regex: bool("Treat pattern as a regular expression. Default false: plain text."),
      case_sensitive: bool("Default false."),
    },
    ["pattern"],
  ),
  tool(
    "edit",
    "Change part of a text: replace `find` (exact text, copied from read) with `replace`. Fails if `find` isn't there, or is there more than once without replace_all. Only edit when the person asked for the change or approved it. Logged with a diff they can revert.",
    {
      path: str("The text to change."),
      find: str("The exact text to replace."),
      replace: str("What goes in its place ('' deletes it)."),
      replace_all: bool("Replace every occurrence. Default false."),
    },
    ["path", "find", "replace"],
  ),
  tool(
    "write",
    "Replace a whole text, or create one: a file under agent/, a custom field on a card ('cards/<card>/<new field>'), or a chat's own prompt block ('chats/<chat>/blocks/<new title>'). Use edit for small changes to existing text. Only change the person's cards, prompts and chats when asked; your own files under agent/ are yours. Logged and revertable.",
    { path: str("Where."), content: str("The whole text.") },
    ["path", "content"],
  ),
  tool(
    "delete",
    "Delete one of your files, a card's custom field, or a chat's own prompt block. Only when asked. Logged and revertable.",
    { path: str("What to delete.") },
    ["path"],
  ),
  tool(
    "preview_prompt",
    "See exactly what the roleplay model would be sent for a chat's next reply, block by block, with macros filled. Older messages are cut short unless full is true.",
    { chat: str("The chat's name. Default: the open chat."), full: bool("Show every message in full. Default false.") },
  ),
  tool(
    "resolve_macros",
    "Fill the macros in a text ({{user}}, {{char}}, {{random::a::b}}, ...) the way a chat's prompt would, without saving any variables.",
    { text: str("Text with macros."), chat: str("The chat's name. Default: the open chat.") },
    ["text"],
  ),
  tool(
    "count_tokens",
    "Roughly count tokens (about four characters each) in a text, or in what's at a path.",
    { path: str("A path to count."), text: str("Or the text itself.") },
  ),
  tool(
    "ask_user",
    "Ask the person a question with choices, and stop until they answer. Use it when a request can be read more than one way, or before a change they may not want. They can also answer in their own words.",
    {
      question: str("The question."),
      options: {
        type: "array",
        description: "Two to five choices.",
        items: { type: "object", properties: { label: str("Short choice."), description: str("What it means. Optional.") }, required: ["label"] },
      },
    },
    ["question", "options"],
  ),
  tool(
    "remember",
    "Keep a note for later sessions: a preference, a decision, a fact about the story. Goes into agent/index.md (read at the start of every session), or a chat's notebook (agent/chats/<chat>/notebook.md).",
    { note: str("The note, one line or a few."), heading: str("A section to put it under, e.g. 'Preferences'. Optional."), chat: str("Put it in this chat's notebook instead. Optional.") },
    ["note"],
  ),
  tool("list_edits", "List your recent changes with their ids, newest first.", { limit: int("How many. Default 20.") }),
  tool(
    "revert_edit",
    "Undo one of your changes by id (from list_edits). Refuses if the text has changed since, unless force.",
    { id: str("The change's id."), force: bool("Revert even if it has changed since. Default false.") },
    ["id"],
  ),
];

/** What the tools need besides their arguments. */
export interface ToolEnv {
  ws: Workspace;
  ctx: EditContext;
  /** The chat that's open, if any. */
  chatId: string | null;
}

type Args = Record<string, unknown>;

/** Run one tool call. Never throws: a failure comes back as an "Error:" text. */
export function runTool(name: string, rawArgs: string, env: ToolEnv): ToolResult {
  let args: Args;
  try {
    const parsed = JSON.parse(rawArgs || "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    args = parsed as Args;
  } catch {
    return { text: `Error: the arguments for ${name} weren't valid JSON. Send them again as a JSON object.` };
  }
  try {
    const fn = TOOLS[name];
    if (!fn) return { text: `Error: there's no tool called ${name}.` };
    return fn(args, env);
  } catch (error) {
    return { text: `Error: ${(error as Error).message}` };
  }
}

const text = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new Error(`${name} must be text.`);
  return v;
};

function chatOf(env: ToolEnv, raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return env.ws.findChat(raw).id;
  if (env.chatId) return env.chatId;
  throw new Error("No chat is open. Name one with chat.");
}

/** Text around each hit, on one line. */
function around(source: string, index: number, length: number): string {
  const from = Math.max(0, index - 60);
  const to = Math.min(source.length, index + length + 60);
  return (from > 0 ? "…" : "") + source.slice(from, to).replace(/\s+/g, " ") + (to < source.length ? "…" : "");
}

function appendUnder(doc: string, heading: string | undefined, note: string): string {
  const line = note.trim().startsWith("-") ? note.trim() : `- ${note.trim()}`;
  if (!heading) return doc.replace(/\s*$/, "") + `\n${line}\n`;
  const lines = doc.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === heading.trim().toLowerCase());
  if (at < 0) return doc.replace(/\s*$/, "") + `\n\n## ${heading.trim()}\n\n${line}\n`;
  let end = at + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end]!)) end++;
  while (end > at + 1 && lines[end - 1]!.trim() === "") end--;
  lines.splice(end, 0, line);
  return lines.join("\n");
}

function describeEdit(e: AgentEdit): string {
  const what = e.before === null ? "created" : e.after === null ? "deleted" : "edited";
  return `${e.id}  ${what} ${e.path}${e.revertedAt ? " (reverted)" : ""}  ${e.createdAt.slice(0, 16).replace("T", " ")}`;
}

const TOOLS: Record<string, (args: Args, env: ToolEnv) => ToolResult> = {
  list(args, env) {
    const path = typeof args.path === "string" ? args.path : "";
    const entries = env.ws.list(path);
    if (entries.length === 0) return { text: `${path || "/"} is empty.` };
    return { text: entries.map((e) => (e.note ? `${e.path}  (${e.note})` : e.path)).join("\n") };
  },

  read(args, env) {
    const { path, text: body } = env.ws.read(text(args.path, "path"));
    const lines = body.split("\n");
    const start = Number.isInteger(args.start_line) ? Math.max(1, args.start_line as number) : 1;
    const end = Number.isInteger(args.end_line) ? Math.min(lines.length, args.end_line as number) : lines.length;
    let out = lines.slice(start - 1, end).join("\n");
    let note = start > 1 || end < lines.length ? ` (lines ${start}-${end} of ${lines.length})` : "";
    if (out.length > MAX_READ) {
      const shown = out.slice(0, MAX_READ).split("\n").length - 1;
      out = out.slice(0, MAX_READ);
      note = ` (cut at ${MAX_READ} characters: read on from line ${start + shown} with start_line)`;
    }
    return { text: `${path}${note}\n\n${out}` };
  },

  grep(args, env) {
    const pattern = text(args.pattern, "pattern");
    if (!pattern) throw new Error("pattern can't be empty.");
    const flags = args.case_sensitive === true ? "g" : "gi";
    let re: RegExp;
    try {
      re = new RegExp(args.regex === true ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (error) {
      throw new Error(`That isn't a valid regular expression (${(error as Error).message}).`);
    }
    const hits: string[] = [];
    let total = 0;
    let texts = 0;
    for (const t of env.ws.texts(typeof args.path === "string" ? args.path : "")) {
      let found = false;
      for (const m of t.text.matchAll(re)) {
        if (m[0] === "") break;
        total++;
        found = true;
        if (hits.length < MAX_HITS) hits.push(`${t.path}: ${around(t.text, m.index!, m[0].length)}`);
      }
      if (found) texts++;
    }
    if (total === 0) return { text: "No matches." };
    const more = total > hits.length ? `\n(${total - hits.length} more not shown: search a narrower path.)` : "";
    return { text: `${total} match${total === 1 ? "" : "es"} in ${texts} text${texts === 1 ? "" : "s"}:\n${hits.join("\n")}${more}` };
  },

  edit(args, env) {
    const path = text(args.path, "path");
    const find = text(args.find, "find");
    const replace = text(args.replace, "replace");
    if (!find) throw new Error("find can't be empty. Use write to replace the whole text.");
    const { path: full, text: current } = env.ws.read(path);
    const count = current.split(find).length - 1;
    if (count === 0) throw new Error(`That exact text isn't in ${full}. Read it again and copy the text exactly, spaces and punctuation included.`);
    if (count > 1 && args.replace_all !== true) throw new Error(`That text is in ${full} ${count} times. Include more of the words around it to pick one, or set replace_all.`);
    const next = args.replace_all === true ? current.split(find).join(replace) : current.replace(find, () => replace);
    const edit = env.ws.write(full, next, env.ctx);
    return { text: `Edited ${full}${count > 1 ? ` (${count} places)` : ""}. Change id: ${edit.id}.`, edits: [edit] };
  },

  write(args, env) {
    const edit = env.ws.write(text(args.path, "path"), text(args.content, "content"), env.ctx);
    return { text: `${edit.before === null ? "Created" : "Rewrote"} ${edit.path}. Change id: ${edit.id}.`, edits: [edit] };
  },

  delete(args, env) {
    const edit = env.ws.remove(text(args.path, "path"), env.ctx);
    return { text: `Deleted ${edit.path}. Change id: ${edit.id}.`, edits: [edit] };
  },

  preview_prompt(args, env) {
    const chatId = chatOf(env, args.chat);
    const prompt = buildPreview(env, chatId);
    const messageBlocks = prompt.blocks.filter((b) => b.source.startsWith("message:"));
    const keepFull = new Set(args.full === true ? messageBlocks : messageBlocks.slice(-4));
    const parts = prompt.blocks.map((b, i) => {
      const where = b.depth !== undefined ? `, depth ${b.depth}` : "";
      const cut = b.source.startsWith("message:") && !keepFull.has(b) && b.content.length > 300 ? b.content.slice(0, 300) + " …(cut)" : b.content;
      return `[${i + 1}] ${b.label} (${b.role}${where})\n${cut}`;
    });
    return { text: `About ${prompt.approxTokens} tokens in ${prompt.messages.length} messages.\n\n${parts.join("\n\n")}` };
  },

  resolve_macros(args, env) {
    const chatId = chatOf(env, args.chat);
    const probe: PromptBlock = { id: "__probe", chatId, kind: "text", cardId: null, fieldId: null, title: "probe", content: text(args.text, "text"), role: "system", enabled: true, depth: null, position: 1e9 };
    const prompt = buildPreview(env, chatId, probe);
    return { text: prompt.blocks.find((b) => b.source === "block:__probe")?.content ?? "(empty)" };
  },

  count_tokens(args, env) {
    const body = typeof args.path === "string" && args.path ? env.ws.read(args.path).text : typeof args.text === "string" ? args.text : null;
    if (body === null) throw new Error("Give a path or a text.");
    return { text: `About ${Math.round(body.length / 4)} tokens (${body.length} characters).` };
  },

  ask_user(args) {
    const question = text(args.question, "question");
    if (!Array.isArray(args.options) || args.options.length === 0) throw new Error("Give at least one option.");
    void question;
    return { text: "Asked. Wait for their answer, which comes as their next message.", stop: true };
  },

  remember(args, env) {
    const note = text(args.note, "note");
    if (!note.trim()) throw new Error("The note is empty.");
    const heading = typeof args.heading === "string" && args.heading.trim() ? args.heading : undefined;
    const path = typeof args.chat === "string" && args.chat.trim() ? `agent/chats/${env.ws.findChat(args.chat).name}/notebook.md` : "agent/index.md";
    let current = "";
    try {
      current = env.ws.read(path).text;
    } catch {
      current = typeof args.chat === "string" ? "# Notebook\n" : "# Notes\n";
    }
    const edit = env.ws.write(path, appendUnder(current, heading, note), env.ctx);
    return { text: `Noted in ${edit.path}.`, edits: [edit] };
  },

  list_edits(args, env) {
    const limit = Number.isInteger(args.limit) ? (args.limit as number) : 20;
    const edits = env.ws.agent.edits({ limit });
    return { text: edits.length ? edits.map(describeEdit).join("\n") : "No changes yet." };
  },

  revert_edit(args, env) {
    const edit = env.ws.revert(text(args.id, "id"), args.force === true);
    return { text: `Reverted: ${describeEdit(edit)}` };
  },
};

function buildPreview(env: ToolEnv, chatId: string, extra?: PromptBlock) {
  const store = env.ws.store;
  const blocks = store.blocks(chatId);
  if (extra) blocks.push(extra);
  return assemblePrompt({ blocks, cards: new Map(store.cards().map((c) => [c.id, c])), messages: store.messages(chatId), vars: store.vars(chatId), globals: store.vars("global") });
}
