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
import { ApiError, createChatCompletion, type ApiOptions } from "./nanogpt.ts";
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
- chats/<chat>/messages/<n>: a chat's messages, 1 is the first; the version shown
- chats/<chat>/blocks/<block>: the blocks on a chat's prompts page, in order
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
  text: string;
  chatId: string | null;
  signal?: AbortSignal;
}

/**
 * One turn: your message, then the agent's tool calls and reply. Everything
 * is saved as it happens, so a failure partway keeps what was done.
 */
export async function runTurn(deps: { store: Store; agent: AgentStore; ws: Workspace; api: ApiOptions }, input: TurnInput): Promise<TurnResult> {
  const { store, agent, ws, api } = deps;
  const settings = store.settings();
  if (!settings.agentProfileId) throw new ValidationError("Pick a profile for the agent first (Settings → Agent).");
  const profile = store.profile(settings.agentProfileId);
  if (!profile.model) throw new ValidationError(`The profile "${profile.name}" has no model yet.`);
  const text = input.text.trim();
  if (!text) throw new ValidationError("Write something to the agent first.");

  const session = agent.updateSession(input.sessionId, { chatId: input.chatId });
  if (session.scope === "chat" && !session.chatId) throw new ValidationError("This session's chat was deleted. Start a session with the main agent instead.");
  const turnId = newId();
  const added: AgentMessage[] = [];
  const edits: AgentEdit[] = [];
  added.push(agent.addMessage({ sessionId: session.id, turnId, role: "user", content: text }));
  if (session.title === "New session") agent.updateSession(session.id, { title: text.replace(/\s+/g, " ").slice(0, 60) });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    const conversation: AgentApiMessage[] = [
      { role: "system", content: systemPrompt(store, agent, ws, session.chatId, session.scope) },
      ...toApiMessages(agent.messages(session.id), turnId),
    ];
    const result = await createChatCompletion(api, {
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
    });

    const calls = last ? [] : result.toolCalls;
    if (calls.length === 0) {
      const content = result.content.trim() || (round > 0 ? "(Done.)" : "");
      if (!content) throw new ApiError("The model returned an empty reply.");
      added.push(agent.addMessage({ sessionId: session.id, turnId, role: "assistant", content }));
      return { messages: added, edits };
    }

    const apiCalls: ApiToolCall[] = calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
      ...(c.extraContent ? { extra_content: c.extraContent } : {}),
    }));
    added.push(agent.addMessage({ sessionId: session.id, turnId, role: "assistant", content: result.content, toolCalls: apiCalls }));

    let stop = false;
    for (const call of calls) {
      // After a question, the rest wait for the answer.
      const outcome = stop
        ? { text: "Not run: you asked the person a question first. Wait for their answer." }
        : runTool(call.name, call.arguments, { ws, ctx: { sessionId: session.id, turnId }, chatId: session.chatId, scope: session.scope });
      if (outcome.edits) edits.push(...outcome.edits);
      if ("stop" in outcome && outcome.stop) stop = true;
      added.push(agent.addMessage({ sessionId: session.id, turnId, role: "tool", content: outcome.text, toolCallId: call.id, toolName: call.name }));
    }
    if (stop) return { messages: added, edits };
  }
  return { messages: added, edits };
}
