/**
 * The agent: a model with tools that helps write and tune cards, prompts
 * and chats, modelled on LumiAgent. It thinks with its own connection
 * profile (Settings → Agent), reads and changes things through the tools
 * in `agenttools.ts`, and logs every change so it can be reverted.
 *
 * It changes things only when asked: that's in its instructions, not
 * enforced, the way LumiAgent leaves it to the model.
 */

import { TOOL_SPECS, runTool } from "./agenttools.ts";
import type { AgentStore } from "./agentstore.ts";
import { ValidationError, newId } from "./errors.ts";
import { ApiError, CancelledError, streamChatCompletion, type ApiOptions, type LiveReply } from "./nanogpt.ts";
import type { Store } from "./store.ts";
import type { AgentApiMessage, AgentEdit, AgentMessage, AgentSession, ApiToolCall } from "./types.ts";
import type { Workspace } from "./workspace.ts";

/** Tool rounds in one turn before the agent has to answer in words. */
export const MAX_ROUNDS = 24;
/** Tool results from earlier turns are cut to this, to keep long sessions affordable. */
const OLD_RESULT_CHARS = 1500;

export interface TurnResult {
  messages: AgentMessage[];
  edits: AgentEdit[];
  /** Stopped with the Stop button before it finished. */
  stopped?: boolean;
}

/** The agent's standing instructions, with its files and a map of what's there now. */
export function systemPrompt(store: Store, agent: AgentStore, ws: Workspace, chatId: string | null, scope: AgentSession["scope"] = "main"): string {
  const ownPersonality = scope === "chat" && chatId ? agent.file(`chats/${chatId}/personality.md`)?.content.trim() : undefined;
  const personality = ownPersonality ?? agent.file("personality.md")?.content.trim() ?? "";
  const index = agent.file("index.md")?.content.trim() ?? "";
  const notebook = chatId ? agent.file(`chats/${chatId}/notebook.md`)?.content.trim() : "";
  const cards = store.cards();
  const chats = store.chats();
  const open = chatId ? chats.find((c) => c.id === chatId) : undefined;
  const files = agent.files().map((f) => ws.displayFilePath(f.path));

  const who =
    scope === "chat" && open
      ? `You are the agent for one chat in Anoesia, a roleplay app: "${open.name}". You help the person who uses it write and tune this chat: its messages, its prompt blocks, its cast's cards, and the notebook you keep for it at agent/chats/${open.name}/notebook.md. You are not the roleplay narrator: you work on the story from outside it. Your folder is agent/chats/${open.name}/, and your personality is its personality.md.`
      : `You are the agent inside Anoesia, a roleplay app. You help the person who uses it write and tune their cards, prompts and chats. You are not the roleplay narrator: you work on the story from outside it.`;
  return [
    who,
    personality,
    `## How you work

- Reading, listing, searching and previewing are always fine. Change the person's cards, prompts and messages only when they ask you to, or after they approve a change you proposed. When a request is unclear, ask (ask_user) or propose the change in words first.
- Your own files under agent/ are yours to keep up: notes, drafts, a folder per chat.
- Every change you make is logged with its text before and after, and the person can revert it. After changing something, say briefly what you changed.
- Drafts (a card rewrite, a new block, a scene) go in agent/notes/ unless they say otherwise. Tell them the path.
- To comb a chat (take out a habit, retcon a detail): grep the chat's messages, read each hit, and edit each message with the smallest change that does it. Don't touch anything else in the message. Report how many messages you changed.
- Use edit for small changes and write for whole texts. Copy find text exactly from read.
- Keep lasting preferences and decisions with remember.${scope === "chat" ? " Notes about this story (what happened, what's true now, what to keep consistent) go in this chat's notebook: remember puts them there unless you pass global. The notebook is never sent to the roleplay model." : ""}

## Paths

- cards/<card>/<field>: a card's fields (Description, Advanced description, System prompt, and custom fields)
- prompt/main: the main prompt, shared by every chat
- chats/<chat>/messages/<n>: a chat's messages, 1 is the first; the version shown. list one to see its versions: chats/<chat>/messages/<n>/versions/<k> (each can be read and edited, to stitch lines from one into another), and chats/<chat>/messages/<n>/reasoning (the narrator's reasoning or plan behind the version shown, read only; versions/<k>/reasoning for another version). Read the reasoning when a reply went wrong, to see why.
- chats/<chat>/blocks/<block>: the blocks on a chat's prompts page, in order. Two are the chat's notes, sent to the roleplay model when they have text: "Right now" (where the story stands) and "Who knows what" (one line per secret). Story state goes there, never in a card: cards describe who someone is.
- chats/<chat>/layout: every block in the order sent, one "Name | on | system" line each ("| depth N" places it inside the chat history, N messages from the end), and "(chat history)" where the history goes. Edit it to switch blocks on or off, move them, or change their role or depth: list every block once. Add or delete blocks under blocks/.
- chats/<chat>/cast: who's onstage, one "Name: onstage" or "Name: offstage" line per cast member. Offstage, only the card's Description is sent and {{cast}} leaves them out. Edit a line to move someone on or off stage.
- agent/index.md (your notes, below), agent/personality.md, agent/notes/, agent/chats/<chat>/ (a folder for each chat)`,
    index ? `## Your notes (agent/index.md)\n\n${index}` : "",
    notebook ? `## This chat's notebook (agent/chats/${open?.name}/notebook.md)\n\n${notebook}` : "",
    `## What's here now

Cards: ${cards.map((c) => c.name + (c.isPersona ? " (the person's own character)" : "")).join(", ") || "none yet"}
Chats: ${chats.map((c) => `${c.name} (${store.messages(c.id).length} messages)`).join(", ") || "none yet"}
Open chat: ${open ? open.name : "none"}
Your files: ${files.join(", ") || "none"}
Today: ${new Date().toISOString().slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A stored session as API messages. Tool results from earlier turns are cut short. */
export function toApiMessages(messages: AgentMessage[], currentTurnId: string): AgentApiMessage[] {
  const out: AgentApiMessage[] = [];
  for (const m of messages) {
    if (m.hidden) continue;
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") out.push(m.toolCalls?.length ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls } : { role: "assistant", content: m.content });
    else {
      const content = m.turnId !== currentTurnId && m.content.length > OLD_RESULT_CHARS ? m.content.slice(0, OLD_RESULT_CHARS) + "\n…(cut: this was an earlier turn; read it again if you need it)" : m.content;
      out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content });
    }
  }
  return out;
}

export interface TurnInput {
  sessionId: string;
  /** Your message. Left out with `again`. */
  text: string;
  chatId: string | null;
  signal?: AbortSignal;
  /** Answer your last message again (a reroll, or your message edited): no new message is saved. */
  again?: boolean;
  /** Runs once the turn is known to be able to start, before it does (taking back the old answer). */
  setup?: () => void;
}

/** What a turn tells its watchers as it goes. */
export interface TurnHooks {
  /** The reply being written this round, so far (its reasoning and its text). */
  onUpdate?: (live: LiveReply) => void;
  /** A message was saved (a reply, a tool call, a tool's result). */
  onSaved?: () => void;
}

/** A turn that has been checked and has your message saved, ready to run. */
export interface PreparedTurn {
  sessionId: string;
  turnId: string;
  run: (hooks?: TurnHooks) => Promise<TurnResult>;
}

/**
 * Check a turn can start and save your message (throws `ValidationError`
 * when it can't), then hand back `run`, which does the rest. Split so the
 * server can answer "can't" at once and run the turn in the background.
 */
export function prepareTurn(deps: { store: Store; agent: AgentStore; ws: Workspace; api: ApiOptions }, input: TurnInput): PreparedTurn {
  const { store, agent, ws, api } = deps;
  const settings = store.settings();
  if (!settings.agentProfileId) throw new ValidationError("Pick a profile for the agent first (Settings → Connections).");
  const profile = store.profile(settings.agentProfileId);
  if (!profile.model) throw new ValidationError(`The profile "${profile.name}" has no model yet.`);
  const text = input.text.trim();
  if (!text && !input.again) throw new ValidationError("Write something to the agent first.");

  const session = agent.updateSession(input.sessionId, { chatId: input.chatId });
  if (session.scope === "chat" && !session.chatId) throw new ValidationError("This session's chat was deleted. Start a session with the main agent instead.");
  input.setup?.();
  const turnId = newId();
  const added: AgentMessage[] = [];
  const edits: AgentEdit[] = [];
  if (input.again) {
    if (agent.messages(session.id).filter((m) => !m.hidden).at(-1)?.role !== "user") throw new ValidationError("There's no message of yours at the end to answer again.");
  } else {
    added.push(agent.addMessage({ sessionId: session.id, turnId, role: "user", content: text }));
    if (session.title === "New session") agent.updateSession(session.id, { title: text.replace(/\s+/g, " ").slice(0, 60) });
  }

  const run = async (hooks: TurnHooks = {}): Promise<TurnResult> => {
    const save = (m: Parameters<AgentStore["addMessage"]>[0]) => {
      added.push(agent.addMessage(m));
      hooks.onSaved?.();
    };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (input.signal?.aborted) return { messages: added, edits, stopped: true };
      const last = round === MAX_ROUNDS - 1;
      const conversation: AgentApiMessage[] = [
        { role: "system", content: systemPrompt(store, agent, ws, session.chatId, session.scope) },
        ...toApiMessages(agent.messages(session.id), turnId),
      ];
      hooks.onUpdate?.({ reasoning: "", content: "" });
      let result;
      try {
        result = await streamChatCompletion(
          api,
          {
            model: profile.model,
            provider: profile.provider,
            messages: conversation,
            temperature: profile.temperature,
            maxTokens: profile.maxTokens,
            topP: profile.topP,
            minP: profile.minP,
            reasoningEffort: profile.reasoningEffort,
            extraParams: profile.extraParams ? (JSON.parse(profile.extraParams) as Record<string, unknown>) : undefined,
            tools: TOOL_SPECS,
            toolChoice: last ? "none" : "auto",
            allowEmpty: round > 0,
            signal: input.signal,
          },
          (live) => hooks.onUpdate?.(live),
        );
      } catch (error) {
        // Stopped: keep the words that had arrived, like a reply that ended there.
        if (!(error instanceof CancelledError)) throw error;
        const partial = error.partial.content.trim();
        if (partial) save({ sessionId: session.id, turnId, role: "assistant", content: partial });
        return { messages: added, edits, stopped: true };
      }

      const calls = last ? [] : result.toolCalls;
      if (calls.length === 0) {
        const content = result.content.trim() || (round > 0 ? "(Done.)" : "");
        if (!content) throw new ApiError("The model returned an empty reply.");
        save({ sessionId: session.id, turnId, role: "assistant", content });
        return { messages: added, edits };
      }

      const apiCalls: ApiToolCall[] = calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
        ...(c.extraContent ? { extra_content: c.extraContent } : {}),
      }));
      save({ sessionId: session.id, turnId, role: "assistant", content: result.content, toolCalls: apiCalls });

      let stop = false;
      for (const call of calls) {
        // After a question, the rest wait for the answer.
        const outcome = stop
          ? { text: "Not run: you asked the person a question first. Wait for their answer." }
          : runTool(call.name, call.arguments, { ws, ctx: { sessionId: session.id, turnId }, chatId: session.chatId, scope: session.scope });
        if (outcome.edits) edits.push(...outcome.edits);
        if ("stop" in outcome && outcome.stop) stop = true;
        save({ sessionId: session.id, turnId, role: "tool", content: outcome.text, toolCallId: call.id, toolName: call.name });
      }
      if (stop) return { messages: added, edits };
    }
    return { messages: added, edits };
  };
  return { sessionId: session.id, turnId, run };
}

/**
 * One turn: your message, then the agent's tool calls and reply. Everything
 * is saved as it happens, so a failure or a stop partway keeps what was done.
 */
export async function runTurn(deps: { store: Store; agent: AgentStore; ws: Workspace; api: ApiOptions }, input: TurnInput, hooks?: TurnHooks): Promise<TurnResult> {
  return prepareTurn(deps, input).run(hooks);
}

// ------------------------------------------------- versions, rewind, branch

/** One answer to a message of yours: the agent's messages from one run, and whether it's an earlier version. */
export interface Run {
  turnId: string;
  messages: AgentMessage[];
  hidden: boolean;
}

/** Your message and its answers: the one shown, and earlier versions (rerolled). */
export interface Exchange {
  user: AgentMessage | null;
  runs: Run[];
}

/** A session's messages as exchanges, in order. */
export function exchanges(messages: AgentMessage[]): Exchange[] {
  const out: Exchange[] = [];
  for (const m of messages) {
    if (m.role === "user" || !out.length) out.push({ user: m.role === "user" ? m : null, runs: [] });
    if (m.role === "user") continue;
    const ex = out.at(-1)!;
    let run = ex.runs.find((r) => r.turnId === m.turnId);
    if (!run) ex.runs.push((run = { turnId: m.turnId, messages: [], hidden: m.hidden }));
    run.messages.push(m);
  }
  return out;
}

type Deps = { agent: AgentStore; ws: Workspace };

const shownRun = (ex: Exchange) => ex.runs.find((r) => !r.hidden);

/** Every change these answers made. */
function editsOf(agent: AgentStore, runs: Run[]): AgentEdit[] {
  return runs.flatMap((r) => agent.edits({ turnId: r.turnId, limit: 1000 }));
}

/**
 * Take back the last answer before it's written again: its changes are
 * reverted (and set aside, to put back if you switch to it again) and its
 * messages kept as an earlier version. Throws `ConflictError` (nothing
 * changed) when something it changed was changed again since, unless `force`.
 */
export function setAsideLastAnswer({ agent, ws }: Deps, sessionId: string, force: boolean): void {
  const last = exchanges(agent.messages(sessionId)).at(-1);
  if (!last?.user) throw new ValidationError("There's no message of yours to answer again.");
  const run = shownRun(last);
  if (!run) return;
  agent.db.transaction(() => {
    ws.revertEdits(editsOf(agent, [run]), force, true);
    agent.setHidden(run.messages.map((m) => m.id), true);
  })();
}

/**
 * Show another version of the last answer (0 is the first): the shown one's
 * changes are set aside and the other's put back. All or nothing: a
 * conflict changes nothing, unless `force`.
 */
export function switchVersion({ agent, ws }: Deps, sessionId: string, index: number, force: boolean): void {
  const last = exchanges(agent.messages(sessionId)).at(-1);
  const target = last?.runs[index];
  if (!last || !target) throw new ValidationError("There's no such version.");
  const current = shownRun(last);
  if (current === target) return;
  agent.db.transaction(() => {
    if (current) {
      ws.revertEdits(editsOf(agent, [current]), force, true);
      agent.setHidden(current.messages.map((m) => m.id), true);
    }
    ws.reapplyEdits(editsOf(agent, [target]).filter((e) => e.setAside), force);
    agent.setHidden(target.messages.map((m) => m.id), false);
  })();
}

/**
 * Where a rewind or branch cuts: at your message, its answers go too; at
 * one of the agent's, its whole answer (and its other versions) stays.
 * Returns the messages kept and the exchanges cut.
 */
function cut(agent: AgentStore, messageId: string): { session: AgentSession; kept: AgentMessage[]; cut: Exchange[]; message: AgentMessage } {
  const message = agent.message(messageId);
  const session = agent.session(message.sessionId);
  const all = exchanges(agent.messages(session.id));
  const at = all.findIndex((ex) => ex.user?.id === messageId || ex.runs.some((r) => r.messages.some((m) => m.id === messageId)));
  if (at < 0) throw new ValidationError("That message isn't in this session.");
  const ex = all[at]!;
  if (message.role === "user") {
    return { session, message, kept: all.slice(0, at).flatMap(flat).concat(ex.user!), cut: [{ user: null, runs: ex.runs }, ...all.slice(at + 1)] };
  }
  return { session, message, kept: all.slice(0, at + 1).flatMap(flat), cut: all.slice(at + 1) };
}

const flat = (ex: Exchange): AgentMessage[] => [...(ex.user ? [ex.user] : []), ...ex.runs.flatMap((r) => r.messages)];

/** How many changes a rewind to this message would take back. */
export function rewindCount({ agent }: Deps, messageId: string): number {
  const { cut: gone } = cut(agent, messageId);
  return editsOf(agent, gone.flatMap((ex) => ex.runs)).filter((e) => !e.revertedAt).length;
}

/**
 * Go back to a message: everything after it goes, and what the agent did
 * after it is reverted. A conflict changes nothing, unless `force`.
 */
export function rewind({ agent, ws }: Deps, messageId: string, force: boolean): void {
  const { cut: gone } = cut(agent, messageId);
  agent.db.transaction(() => {
    ws.revertEdits(editsOf(agent, gone.flatMap((ex) => ex.runs)), force);
    agent.deleteMessages(gone.flatMap(flat).map((m) => m.id));
  })();
}

/** A new session with this one's conversation up to a message (the versions shown). The changes stay with the original. */
export function branch({ agent }: Deps, messageId: string): AgentSession {
  const { session, kept } = cut(agent, messageId);
  const copy = agent.createSession({ title: `${session.title} (branch)`, scope: session.scope, chatId: session.chatId });
  agent.copyMessages(copy.id, kept.filter((m) => !m.hidden));
  return agent.session(copy.id);
}

/** Change the words of your message or the agent's reply (not a tool call). */
export function editText({ agent }: Deps, messageId: string, raw: unknown): AgentMessage {
  const m = agent.message(messageId);
  if (typeof raw !== "string" || !raw.trim()) throw new ValidationError("A message can't be empty.");
  if (m.role === "tool" || m.toolCalls?.length) throw new ValidationError("Only your messages and the agent's replies can be edited.");
  return agent.setMessageText(m.id, raw.trim());
}
