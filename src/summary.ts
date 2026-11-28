/**
 * The story so far: older messages folded into a summary, so a long chat
 * stops sending every old line word for word.
 *
 * Each chat has a note called "Story so far" (a chat note like "Right now",
 * on the prompts page and in the scene menu, yours to read and edit). A
 * chat also remembers how far that note reaches: `through`, the seq of the
 * last message folded into it. When the note is switched on and has text,
 * the messages up to `through` are left out of the prompt and the note
 * stands in for them; the rest go word for word. Nothing else is ever left
 * out, so a chat with no summary sends what it always did.
 *
 * Folding writes the next part of the note: the model reads the note so far
 * and the next messages, and writes those messages as finished beats, which
 * are added to the end of the note (what you wrote in it stays as it is).
 * The chat keeps its last `keep` messages word for word, and folds on its
 * own (`auto`) once FOLD_BATCH messages are waiting past them, so the
 * prompt's start doesn't change every turn.
 *
 * The reach is saved with the chat's notes at each message, so rewinding
 * and branching take the summary back to how it stood there. A fingerprint
 * of the folded messages notices when one of them is edited, deleted or
 * shows another version afterwards: the summary is then marked to check.
 */

import { shortenVisuals } from "../public/js/visuals.js";
import type { Chat, ChatMessage, Message } from "./types.ts";

export const SUMMARY_NOTE = "Story so far";
/** Fold once this many messages wait past the ones kept word for word. */
export const FOLD_BATCH = 20;
/** At most this many messages go into one folding request. */
export const FOLD_CHUNK = 60;
export const DEFAULT_KEEP = 50;
export const MIN_KEEP = 4;
export const MAX_KEEP = 999;

/** A fingerprint of the messages a summary covers: their order and the versions shown. */
export function coverHash(messages: Message[]): string {
  let h = 0x811c9dc5;
  for (const m of messages) {
    const s = `${m.seq}\u0000${m.content}\u0001`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}

export interface FoldStatus {
  /** The seq of the last message folded in (0: none). */
  through: number;
  /** How many of the chat's messages the summary covers. */
  covered: number;
  /** A covered message changed after it was folded. */
  stale: boolean;
  /** Messages older than the kept ones that aren't folded yet. */
  waiting: number;
  keep: number;
  auto: boolean;
}

export function foldStatus(chat: Chat, messages: Message[]): FoldStatus {
  const covered = messages.filter((m) => m.seq <= chat.summary.through);
  return {
    through: chat.summary.through,
    covered: covered.length,
    stale: covered.length > 0 && coverHash(covered) !== chat.summary.hash,
    waiting: Math.max(0, messages.length - chat.summary.keep - covered.length),
    keep: chat.summary.keep,
    auto: chat.summary.auto,
  };
}

/** The messages the next fold takes in: after the covered ones, up to the kept ones, at most FOLD_CHUNK. */
export function nextFold(chat: Chat, messages: Message[]): Message[] {
  const end = messages.length - chat.summary.keep;
  const start = messages.filter((m) => m.seq <= chat.summary.through).length;
  return end > start ? messages.slice(start, Math.min(end, start + FOLD_CHUNK)) : [];
}

export const FOLD_INSTRUCTIONS = `You keep the "Story so far" for a long roleplay. It stands in for older messages that are no longer sent, so the narrator writes the next scenes from it.

Write what happens in the new messages as finished beats, in the past tense, in a few short paragraphs or lines grouped by scene. For each scene say where it was, who was there, and what changed: decisions, reveals, promises, injuries, who learned what.

Close out what is closed. When a conflict, secret or tension was resolved, say so plainly and say how things stand now ("Zoey and Mira met Fae and accepted her; the matter is settled"). Only call something open if it is still open at the end of these messages.

Leave out passing details, objects and turns of phrase that don't matter later. Never quote dialogue at length. Don't add anything that isn't in the messages, and don't repeat what the summary so far already says.

Answer with only the new part of the summary.`;

/** The request that folds `batch` into a summary that so far reads `summary`. */
export function foldMessages(input: { summary: string; batch: Message[]; userName: string; cast: string[] }): ChatMessage[] {
  const lines = input.batch.map((m) => `${m.role === "user" ? input.userName : "Narrator"}: ${shortenVisuals(m.content).trim()}`).join("\n\n");
  const who = input.cast.length ? `\n\nThe user plays ${input.userName}. The cast: ${input.cast.join(", ")}.` : `\n\nThe user plays ${input.userName}.`;
  return [
    { role: "system", content: FOLD_INSTRUCTIONS + who },
    {
      role: "user",
      content: `<summary_so_far>\n${input.summary.trim() || "(nothing yet: these are the first messages)"}\n</summary_so_far>\n\n<new_messages>\n${lines}\n</new_messages>\n\nWrite the next part of the summary, for the new messages only.`,
    },
  ];
}

/** The note with a new part added at the end. */
export function appendPart(note: string, part: string): string {
  const a = note.trimEnd();
  const b = part.trim();
  return a ? `${a}\n\n${b}` : b;
}
