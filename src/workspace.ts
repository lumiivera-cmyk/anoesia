/**
 * The agent's view of Anoesia: everything it can read or change, as paths,
 * the way LumiAgent's tools see Lumiverse.
 *
 *   cards/<card>/<field>              a card's field ("Description", a custom field)
 *   prompt/main                       the main prompt, shared by every chat
 *   chats/<chat>/messages/<n>         a message (1 is the first), the version shown
 *   chats/<chat>/blocks/<block>       a block on the chat's prompts page (its notes too)
 *   chats/<chat>/cast                 who's onstage and offstage, one "Name: onstage" line each
 *   agent/index.md                    the agent's notes, read at the start of every session
 *   agent/personality.md              how it talks
 *   agent/notes/...                   drafts and anything else it keeps
 *   agent/chats/<chat>/...            a folder for each chat
 *
 * Names match without caring about case, and an id works anywhere a name
 * does. Every change goes through `write` or `remove`, which log it with
 * its text before and after (`agent_edits`) so it can be shown as a diff
 * and reverted.
 */

import { AgentStore } from "./agentstore.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { heldBack } from "./prompt.ts";
import type { Store } from "./store.ts";
import type { AgentEdit, Card, Chat, PromptBlock } from "./types.ts";

/** One line of a listing. */
export interface Entry {
  /** The full path; folders end with `/`. */
  path: string;
  /** A short description: a message's author and first words, a block's role, a file's size. */
  note?: string;
}

/** Who's making a change, for the log. */
export interface EditContext {
  sessionId: string;
  turnId: string;
}

type Row = Record<string, unknown>;

/** A place that holds text, resolved from a path. */
interface Target {
  path: string;
  /** Where it lives, for the log: `main`, `field:<id>`, `block:<id>`, `message:<id>:<version>`, `cast:<chat id>`, `file:<path>`. */
  key: string;
  /** The text, or null when it doesn't exist (yet). */
  value: string | null;
  /** Create it (when `value` is null) with this text; returns what's needed to remove it again. */
  create?: (text: string) => { key: string; meta: Record<string, unknown> | null };
  /** Delete it; returns what's needed to put it back. */
  remove?: () => Record<string, unknown> | null;
  /** Why it can't be created or deleted, when it can't. */
  readOnly?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

function split(path: string): string[] {
  return String(path ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== ".");
}

function preview(text: string, length = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? flat.slice(0, length - 1) + "…" : flat;
}

export class Workspace {
  constructor(
    readonly store: Store,
    readonly agent: AgentStore,
  ) {}

  // ------------------------------------------------------------ names

  findCard(name: string): Card {
    const cards = this.store.cards();
    const card = cards.find((c) => c.id === name) ?? cards.find((c) => norm(c.name) === norm(name));
    if (!card) throw new ValidationError(`There's no card named "${name}". The cards are: ${cards.map((c) => c.name).join(", ") || "(none)"}.`);
    return card;
  }

  findChat(name: string): Chat {
    const chats = this.store.chats();
    const chat = chats.find((c) => c.id === name) ?? chats.find((c) => norm(c.name) === norm(name));
    if (!chat) throw new ValidationError(`There's no chat named "${name}". The chats are: ${chats.map((c) => c.name).join(", ") || "(none)"}.`);
    return chat;
  }

  /** A block's name in paths: its title, or "Card: Field" for a card's field. Repeats get " (2)". */
  blockNames(chatId: string): { block: PromptBlock; name: string }[] {
    const cards = new Map(this.store.cards().map((c) => [c.id, c]));
    const seen = new Map<string, number>();
    return this.store
      .blocks(chatId)
      .filter((b) => b.kind !== "history")
      .map((block) => {
        let name = block.kind === "field" ? `${cards.get(block.cardId!)?.name ?? "?"}: ${block.title}` : block.title;
        name = name.replace(/\//g, "-");
        const n = (seen.get(norm(name)) ?? 0) + 1;
        seen.set(norm(name), n);
        return { block, name: n > 1 ? `${name} (${n})` : name };
      });
  }

  /** A chat's cast as text: one "Name: onstage" or "Name: offstage" line per member, in cast order. */
  castText(chatId: string): string {
    const chat = this.store.chat(chatId);
    const cards = new Map(this.store.cards().map((c) => [c.id, c]));
    return chat.cast.map((id) => `${cards.get(id)?.name ?? id}: ${chat.offstage.includes(id) ? "offstage" : "onstage"}`).join("\n");
  }

  /** Set who's onstage from "Name: onstage|offstage" lines. Members not named keep their place. */
  private setCastText(chatId: string, text: string): void {
    const chat = this.store.chat(chatId);
    const cards = this.store.cards().filter((c) => chat.cast.includes(c.id));
    const off = new Set(chat.offstage);
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const m = /^(.+?)\s*:\s*(onstage|offstage)\s*$/i.exec(line);
      if (!m) throw new ValidationError(`"${line}" should read "Name: onstage" or "Name: offstage".`);
      const card = cards.find((c) => c.id === m[1]!.trim()) ?? cards.find((c) => norm(c.name) === norm(m[1]!));
      if (!card) throw new ValidationError(`${m[1]} isn't in ${chat.name}'s cast. The cast is: ${cards.map((c) => c.name).join(", ") || "(nobody)"}. Adding someone to the cast is the person's call, in chat settings.`);
      if (norm(m[2]!) === "offstage") off.add(card.id);
      else off.delete(card.id);
    }
    this.store.updateChat(chatId, { offstage: [...off] });
  }

  /** The stored path of an agent file from its path after `agent/` (chat names become ids). */
  private storedFilePath(parts: string[]): string {
    if (parts[0] === "chats" && parts.length >= 2) return ["chats", this.findChat(parts[1]!).id, ...parts.slice(2)].join("/");
    return parts.join("/");
  }

  /** The agent path of a stored file path (chat ids become names). */
  displayFilePath(stored: string): string {
    const parts = stored.split("/");
    if (parts[0] === "chats" && parts.length >= 2) {
      const chat = this.store.chats().find((c) => c.id === parts[1]);
      if (chat) parts[1] = chat.name;
    }
    return "agent/" + parts.join("/");
  }

  // ------------------------------------------------------------ resolve

  private target(path: string): Target {
    const parts = split(path);
    const [root, a, b, c, ...rest] = parts;
    const where = parts.join("/");
    if (root === "prompt" && a === "main" && parts.length === 2) {
      return { path: "prompt/main", key: "main", value: this.store.settings().mainPrompt, readOnly: "The main prompt always exists." };
    }
    if (root === "cards" && a && b && parts.length === 3) {
      const card = this.findCard(a);
      const field = card.fields.find((f) => f.id === b) ?? card.fields.find((f) => norm(f.title) === norm(b)) ?? card.fields.find((f) => f.key !== "custom" && f.key === norm(b));
      const fieldPath = (title: string) => `cards/${card.name}/${title}`;
      if (field) {
        return {
          path: fieldPath(field.title),
          key: `field:${field.id}`,
          value: field.content,
          remove: field.key === "custom" ? () => this.removeField(field.id) : undefined,
          readOnly: field.key === "custom" ? undefined : "A card's description, advanced description and system prompt always exist. Empty one instead.",
        };
      }
      return {
        path: fieldPath(b),
        key: "",
        value: null,
        create: (text) => {
          const updated = this.store.updateCard(card.id, { fields: [...card.fields, { key: "custom", title: b, content: text }] });
          const created = updated.fields.at(-1)!;
          return { key: `field:${created.id}`, meta: null };
        },
      };
    }
    if (root === "chats" && a && b === "messages" && c && rest.length === 0) {
      const chat = this.findChat(a);
      const messages = this.store.messages(chat.id);
      const n = Number(c);
      const message = Number.isInteger(n) && n >= 1 ? messages[n - 1] : messages.find((m) => m.id === c);
      if (!message) throw new ValidationError(`${chat.name} has ${messages.length} messages, numbered 1 to ${messages.length}. There's no message ${c}.`);
      const number = messages.indexOf(message) + 1;
      return {
        path: `chats/${chat.name}/messages/${number}`,
        key: `message:${message.id}:${message.swipeIndex}`,
        value: message.content,
        readOnly: "Messages can be edited, not created or deleted, here.",
      };
    }
    if (root === "chats" && a && b === "cast" && !c) {
      const chat = this.findChat(a);
      return {
        path: `chats/${chat.name}/cast`,
        key: `cast:${chat.id}`,
        value: this.castText(chat.id),
        readOnly: "The cast list always exists. Change who's onstage or offstage by editing its lines.",
      };
    }
    if (root === "chats" && a && b === "blocks" && c && rest.length === 0) {
      const chat = this.findChat(a);
      const named = this.blockNames(chat.id);
      const hit = named.find((x) => x.block.id === c) ?? named.find((x) => norm(x.name) === norm(c));
      if (hit) {
        const block = hit.block;
        const key = block.kind === "main" ? "main" : block.kind === "field" ? `field:${block.fieldId}` : `block:${block.id}`;
        return {
          path: `chats/${chat.name}/blocks/${hit.name}`,
          key,
          value: block.content,
          remove: block.kind === "text" ? () => this.removeBlock(block.id) : undefined,
          readOnly:
            block.kind === "text"
              ? undefined
              : block.kind === "note"
                ? "Every chat keeps its notes. Empty this one instead: an empty note sends nothing."
                : "Only the chat's own text blocks can be deleted. Switch this one off on the prompts page instead.",
        };
      }
      return {
        path: `chats/${chat.name}/blocks/${c}`,
        key: "",
        value: null,
        create: (text) => {
          const created = this.store.createBlock(chat.id, { title: c, content: text });
          return { key: `block:${created.id}`, meta: null };
        },
      };
    }
    if (root === "agent" && parts.length >= 2) {
      const stored = this.storedFilePath(parts.slice(1));
      const file = this.agent.file(stored);
      return {
        path: this.displayFilePath(stored),
        key: `file:${stored}`,
        value: file ? file.content : null,
        create: (text) => (this.agent.writeFile(stored, text), { key: `file:${stored}`, meta: null }),
        remove: () => (this.agent.deleteFile(stored), null),
      };
    }
    throw new ValidationError(`"${where || "/"}" isn't something that holds text. Use list to see what's there; the top folders are cards/, prompt/, chats/ and agent/.`);
  }

  // --------------------------------------------------------------- read

  /** What's in a folder. */
  list(path = ""): Entry[] {
    const parts = split(path);
    const [root, a, b] = parts;
    if (parts.length === 0) {
      return [
        { path: "cards/", note: "every card and its fields" },
        { path: "prompt/", note: "the main prompt" },
        { path: "chats/", note: "every chat: its messages and prompt blocks" },
        { path: "agent/", note: "your own files: index.md, personality.md, notes/, chats/" },
      ];
    }
    if (root === "prompt" && parts.length === 1) return [{ path: "prompt/main", note: "shared by every chat" }];
    if (root === "cards") {
      if (parts.length === 1) return this.store.cards().map((c) => ({ path: `cards/${c.name}/`, note: [c.isPersona ? "persona" : "", c.isCharacter ? "" : "not a character"].filter(Boolean).join(", ") || undefined }));
      if (parts.length === 2) {
        const card = this.findCard(a!);
        return card.fields.map((f) => ({ path: `cards/${card.name}/${f.title}`, note: f.content ? `${f.content.length} chars` : "empty" }));
      }
    }
    if (root === "chats") {
      if (parts.length === 1) return this.store.chats().map((c) => ({ path: `chats/${c.name}/` }));
      const chat = this.findChat(a!);
      if (parts.length === 2) {
        const count = this.store.messages(chat.id).length;
        const cards = new Map(this.store.cards().map((c) => [c.id, c.name]));
        const names = (ids: string[]) => ids.map((id) => cards.get(id) ?? id).join(", ") || "nobody";
        return [
          { path: `chats/${chat.name}/messages/`, note: `${count} messages` },
          { path: `chats/${chat.name}/blocks/`, note: "its prompt, block by block, with its notes (Right now, Who knows what)" },
          { path: `chats/${chat.name}/cast`, note: `onstage: ${names(chat.cast.filter((id) => !chat.offstage.includes(id)))}; offstage: ${names(chat.offstage)}` },
          { path: `agent/chats/${chat.name}/`, note: "your folder for this chat" },
        ];
      }
      if (parts.length === 3 && b === "messages") {
        const cards = new Map(this.store.cards().map((c) => [c.id, c.name]));
        return this.store.messages(chat.id).map((m, i) => ({
          path: `chats/${chat.name}/messages/${i + 1}`,
          note: `${m.author === "user" || m.author === "narrator" ? m.author : (cards.get(m.author) ?? m.author)}: ${preview(m.content)}`,
        }));
      }
      if (parts.length === 3 && b === "blocks") {
        const cards = new Map(this.store.cards().map((c) => [c.id, c]));
        return this.store.blocks(chat.id).map((block) => {
          if (block.kind === "history") return { path: `chats/${chat.name}/messages/`, note: "the chat history goes here" };
          const name = this.blockNames(chat.id).find((x) => x.block.id === block.id)!.name;
          const where = block.depth === null ? "" : `, depth ${block.depth}`;
          const source = block.kind === "main" ? "shared main prompt" : block.kind === "field" ? "card field" : block.kind === "note" ? "this chat's note" : "this chat's own";
          const held = heldBack(block, cards) ? ", not sent: its card is offstage" : "";
          return { path: `chats/${chat.name}/blocks/${name}`, note: `${source}, ${block.role}${where}${block.enabled ? "" : ", off"}${block.kind === "note" && !block.content.trim() ? ", empty" : ""}${held}` };
        });
      }
    }
    if (root === "agent") {
      const prefix = parts.length > 1 ? this.storedFilePath(parts.slice(1)) + "/" : "";
      const files = this.agent.files().filter((f) => f.path.startsWith(prefix));
      const entries = new Map<string, Entry>();
      for (const f of files) {
        const rest = f.path.slice(prefix.length).split("/");
        const stored = prefix + rest[0];
        if (rest.length === 1) entries.set(stored, { path: this.displayFilePath(stored), note: `${f.content.length} chars` });
        else entries.set(stored + "/", { path: this.displayFilePath(stored) + "/" });
      }
      // The layout is always there, even before anything is saved in it.
      if (prefix === "") {
        entries.set("notes/", { path: "agent/notes/", note: "drafts and anything else to keep" });
        entries.set("chats/", { path: "agent/chats/", note: "a folder for each chat" });
      }
      if (prefix === "chats/") for (const c of this.store.chats()) entries.set(`chats/${c.id}/`, { path: `agent/chats/${c.name}/` });
      return [...entries.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, e]) => e);
    }
    throw new ValidationError(`"${parts.join("/")}" isn't a folder. Use read for text.`);
  }

  /** The text at a path, and its full path. */
  read(path: string): { path: string; text: string } {
    const target = this.target(path);
    if (target.value === null) throw new ValidationError(`Nothing is at ${target.path} yet.`);
    return { path: target.path, text: target.value };
  }

  /** Every text under a path, for searching. */
  *texts(path = ""): Generator<{ path: string; text: string }> {
    const parts = split(path);
    let leaf: { path: string; text: string } | null = null;
    try {
      leaf = this.read(parts.join("/"));
    } catch {
      leaf = null;
    }
    if (leaf) {
      yield leaf;
      return;
    }
    // History blocks list the messages folder: don't walk it twice.
    const seen = new Set<string>();
    for (const entry of this.list(parts.join("/"))) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      if (parts[0] === "chats" && parts[2] === "blocks" && entry.path.endsWith("/")) continue;
      if (parts[0] === "chats" && parts.length === 2 && entry.path.startsWith("agent/")) continue;
      if (entry.path.endsWith("/")) yield* this.texts(entry.path);
      else {
        try {
          yield this.read(entry.path);
        } catch {
          // Listed but empty (a new folder): nothing to search.
        }
      }
    }
  }

  // -------------------------------------------------------------- write

  /** Replace the text at a path, or create it. Logged. */
  write(path: string, text: string, ctx: EditContext): AgentEdit {
    if (typeof text !== "string") throw new ValidationError("The text must be text.");
    const target = this.target(path);
    if (target.value === text) throw new ValidationError(`${target.path} already says exactly that. Nothing changed.`);
    if (target.value === null) {
      if (!target.create) throw new ValidationError(target.readOnly ?? `${target.path} can't be created.`);
      const made = target.create(text);
      return this.agent.addEdit({ ...ctx, path: target.path, target: made.key, before: null, after: text, meta: made.meta });
    }
    if (target.key.startsWith("message:") && text.trim() === "") throw new ValidationError("A message can't be empty.");
    this.setValue(target.key, text);
    return this.agent.addEdit({ ...ctx, path: target.path, target: target.key, before: target.value, after: text, meta: null });
  }

  /** Delete what's at a path. Logged, with what's needed to put it back. */
  remove(path: string, ctx: EditContext): AgentEdit {
    const target = this.target(path);
    if (target.value === null) throw new ValidationError(`Nothing is at ${target.path}.`);
    if (!target.remove) throw new ValidationError(target.readOnly ?? `${target.path} can't be deleted.`);
    const meta = target.remove();
    return this.agent.addEdit({ ...ctx, path: target.path, target: target.key, before: target.value, after: null, meta });
  }

  /** The text a logged target holds now (null: it's gone). */
  valueOf(key: string): string | null {
    const [kind, id, version] = key.split(":");
    const rest = key.slice(kind!.length + 1);
    if (kind === "main") return this.store.settings().mainPrompt;
    if (kind === "field") return (this.store.db.query("SELECT content FROM card_fields WHERE id = ?").get(id!) as { content: string } | null)?.content ?? null;
    if (kind === "block") return (this.store.db.query("SELECT content FROM prompt_blocks WHERE id = ? AND kind IN ('text', 'note')").get(id!) as { content: string } | null)?.content ?? null;
    if (kind === "cast") {
      try {
        return this.castText(id!);
      } catch {
        return null;
      }
    }
    if (kind === "message") {
      try {
        return this.store.message(id!).swipes[Number(version)] ?? null;
      } catch {
        return null;
      }
    }
    if (kind === "file") return this.agent.file(rest)?.content ?? null;
    throw new ValidationError(`Unknown change target ${key}.`);
  }

  private setValue(key: string, text: string): void {
    const [kind, id, version] = key.split(":");
    const rest = key.slice(kind!.length + 1);
    if (kind === "main") this.store.updateSettings({ mainPrompt: text });
    else if (kind === "field") {
      const row = this.store.db.query("SELECT card_id FROM card_fields WHERE id = ?").get(id!) as { card_id: string } | null;
      if (!row) throw new NotFoundError("field");
      this.store.db.query("UPDATE card_fields SET content = ? WHERE id = ?").run(text, id!);
      this.store.db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.card_id);
    } else if (kind === "block") this.store.updateBlock(id!, { content: text });
    else if (kind === "message") {
      const m = this.store.message(id!);
      const index = Number(version);
      if (!(index >= 0 && index < m.swipes.length)) throw new NotFoundError("message version");
      const swipes = [...m.swipes];
      swipes[index] = text;
      this.store.db.query("UPDATE messages SET swipes = ?, edited_at = ? WHERE id = ?").run(JSON.stringify(swipes), new Date().toISOString(), id!);
    } else if (kind === "cast") this.setCastText(id!, text);
    else if (kind === "file") this.agent.writeFile(rest, text);
    else throw new ValidationError(`Unknown change target ${key}.`);
  }

  private removeField(fieldId: string): Record<string, unknown> {
    const row = this.store.db.query("SELECT * FROM card_fields WHERE id = ?").get(fieldId) as Row;
    this.store.db.query("DELETE FROM card_fields WHERE id = ?").run(fieldId);
    return { cardId: row.card_id, key: row.key, title: row.title, position: row.position };
  }

  private removeBlock(blockId: string): Record<string, unknown> {
    const row = this.store.db.query("SELECT * FROM prompt_blocks WHERE id = ?").get(blockId) as Row;
    this.store.deleteBlock(blockId);
    return { chatId: row.chat_id, title: row.title, role: row.role, enabled: row.enabled, depth: row.depth, position: row.position, nudge: row.nudge };
  }

  /** Put back something deleted, under its old id. */
  private restore(key: string, text: string, meta: Record<string, unknown> | null): void {
    const [kind, id] = key.split(":");
    const rest = key.slice(kind!.length + 1);
    const db = this.store.db;
    if (kind === "file") this.agent.writeFile(rest, text);
    else if (kind === "field" && meta) {
      this.store.card(meta.cardId as string);
      db.query("UPDATE card_fields SET position = position + 1 WHERE card_id = ? AND position >= ?").run(meta.cardId as string, meta.position as number);
      db.query("INSERT INTO card_fields (id, card_id, key, title, content, position) VALUES (?, ?, ?, ?, ?, ?)").run(id!, meta.cardId as string, meta.key as string, meta.title as string, text, meta.position as number);
    } else if (kind === "block" && meta) {
      this.store.chat(meta.chatId as string);
      db.query("UPDATE prompt_blocks SET position = position + 1 WHERE chat_id = ? AND position >= ?").run(meta.chatId as string, meta.position as number);
      db.query("INSERT INTO prompt_blocks (id, chat_id, kind, title, content, role, enabled, depth, position, nudge) VALUES (?, ?, 'text', ?, ?, ?, ?, ?, ?, ?)").run(
        id!,
        meta.chatId as string,
        meta.title as string,
        text,
        meta.role as string,
        meta.enabled as number,
        (meta.depth as number | null) ?? null,
        meta.position as number,
        (meta.nudge as number | undefined) ?? 0,
      );
    } else throw new ValidationError("That can't be put back: what held it is gone.");
  }

  private delete(key: string): void {
    const [kind, id] = key.split(":");
    const rest = key.slice(kind!.length + 1);
    if (kind === "file") this.agent.deleteFile(rest);
    else if (kind === "field") this.store.db.query("DELETE FROM card_fields WHERE id = ?").run(id!);
    else if (kind === "block") this.store.deleteBlock(id!);
    else throw new ValidationError("That can't be removed.");
  }

  /**
   * Undo a logged change. If the text has changed since (you edited it
   * after the agent did), it's left alone unless `force` is set, so a
   * revert never throws away newer work without asking.
   */
  revert(editId: string, force = false): AgentEdit {
    const edit = this.agent.edit(editId);
    if (edit.revertedAt) throw new ValidationError("That change is already reverted.");
    const now = this.valueOf(edit.target);
    if (now !== edit.after && !force) {
      throw new ConflictError(`${edit.path} has changed since this edit, so reverting would also undo the newer changes. Revert anyway to put back the text from before the edit.`);
    }
    this.store.db.transaction(() => {
      if (edit.before === null) {
        if (now !== null) this.delete(edit.target);
      } else if (now === null) this.restore(edit.target, edit.before, edit.meta);
      else this.setValue(edit.target, edit.before);
    })();
    return this.agent.markReverted(edit.id);
  }

  /** Undo every change of one turn, newest first. Stops at the first conflict unless `force`. */
  revertTurn(turnId: string, force = false): AgentEdit[] {
    const edits = this.agent.edits({ turnId, limit: 1000 }).filter((e) => !e.revertedAt);
    if (!force) {
      // Check them all first, so a conflict leaves the turn as it was.
      const simulated = new Map<string, string | null>();
      for (const e of edits) {
        const current = simulated.has(e.target) ? simulated.get(e.target)! : this.valueOf(e.target);
        if (current !== e.after) throw new ConflictError(`${e.path} has changed since the agent's edit. Revert anyway to undo the whole turn regardless.`);
        simulated.set(e.target, e.before);
      }
    }
    return edits.map((e) => this.revert(e.id, true));
  }
}

/** A revert that would undo newer changes too. */
export class ConflictError extends ValidationError {
  readonly conflict = true;
}

