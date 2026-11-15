/**
 * Reading and writing everything Anoesia keeps. The layout is in `db.ts`.
 *
 * Every method checks what it's given and throws `ValidationError` with a
 * message meant for you, or `NotFoundError` for an id that isn't there.
 */

import type { Database } from "bun:sqlite";
import { DEFAULT_FIELDS, type ParsedCard } from "./cards.ts";
import { NotFoundError, ValidationError, newId } from "./errors.ts";
import { DEFAULT_MAIN_PROMPT } from "./prompt.ts";
import type { Card, CardField, Chat, FieldKey, Message, Profile, ProviderId, ReasoningEffort, Settings } from "./types.ts";

const now = () => new Date().toISOString();

const DEFAULT_SETTINGS: Settings = {
  rpProfileId: "",
  mainPrompt: DEFAULT_MAIN_PROMPT,
};

type Row = Record<string, unknown>;

export class Store {
  constructor(readonly db: Database) {}

  // ------------------------------------------------------------ settings

  settings(): Settings {
    const rows = this.db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const row of rows) if (row.key in out) (out as unknown as Row)[row.key] = JSON.parse(row.value);
    if (out.rpProfileId && !this.findProfile(out.rpProfileId)) out.rpProfileId = "";
    return out;
  }

  updateSettings(raw: Row): Settings {
    const clean: Partial<Settings> = {};
    if (raw.rpProfileId !== undefined) {
      if (typeof raw.rpProfileId !== "string") throw new ValidationError("rpProfileId must be text");
      if (raw.rpProfileId && !this.findProfile(raw.rpProfileId)) throw new NotFoundError("profile");
      clean.rpProfileId = raw.rpProfileId;
    }
    if (raw.mainPrompt !== undefined) {
      if (typeof raw.mainPrompt !== "string") throw new ValidationError("The main prompt must be text.");
      clean.mainPrompt = raw.mainPrompt;
    }
    const put = this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [key, value] of Object.entries(clean)) put.run(key, JSON.stringify(value));
    return this.settings();
  }

  // ------------------------------------------------------------ profiles

  profiles(): Profile[] {
    return (this.db.query("SELECT * FROM profiles ORDER BY position, created_at").all() as Row[]).map(toProfile);
  }

  findProfile(id: string): Profile | null {
    const row = this.db.query("SELECT * FROM profiles WHERE id = ?").get(id) as Row | null;
    return row ? toProfile(row) : null;
  }

  profile(id: string): Profile {
    const p = this.findProfile(id);
    if (!p) throw new NotFoundError("profile");
    return p;
  }

  createProfile(raw: Row): Profile {
    const fields = profileFields(raw, true);
    const id = newId();
    const position = (this.db.query("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM profiles").get() as { n: number }).n;
    this.db
      .query(
        `INSERT INTO profiles (id, name, provider, model, temperature, max_tokens, top_p, min_p, reasoning_effort, extra_params, position, created_at)
         VALUES ($id, $name, $provider, $model, $temperature, $maxTokens, $topP, $minP, $reasoningEffort, $extraParams, $position, $createdAt)`,
      )
      .run({
        $id: id,
        $name: fields.name ?? "New profile",
        $provider: fields.provider ?? "nanogpt",
        $model: fields.model ?? "",
        $temperature: fields.temperature ?? 1,
        $maxTokens: fields.maxTokens ?? 1024,
        $topP: fields.topP ?? null,
        $minP: fields.minP ?? null,
        $reasoningEffort: fields.reasoningEffort ?? null,
        $extraParams: fields.extraParams ?? "",
        $position: position,
        $createdAt: now(),
      });
    // The first profile writes replies until you pick another.
    if (!this.settings().rpProfileId) this.updateSettings({ rpProfileId: id });
    return this.profile(id);
  }

  updateProfile(id: string, raw: Row): Profile {
    const merged = { ...this.profile(id), ...profileFields(raw, false) };
    this.db
      .query(
        `UPDATE profiles SET name = $name, provider = $provider, model = $model, temperature = $temperature, max_tokens = $maxTokens,
         top_p = $topP, min_p = $minP, reasoning_effort = $reasoningEffort, extra_params = $extraParams WHERE id = $id`,
      )
      .run({
        $id: id,
        $name: merged.name,
        $provider: merged.provider,
        $model: merged.model,
        $temperature: merged.temperature,
        $maxTokens: merged.maxTokens,
        $topP: merged.topP,
        $minP: merged.minP,
        $reasoningEffort: merged.reasoningEffort,
        $extraParams: merged.extraParams,
      });
    return this.profile(id);
  }

  deleteProfile(id: string): void {
    this.profile(id);
    this.db.query("DELETE FROM profiles WHERE id = ?").run(id);
  }

  // --------------------------------------------------------------- cards

  cards(): Card[] {
    const rows = this.db.query("SELECT * FROM cards ORDER BY is_persona DESC, name COLLATE NOCASE").all() as Row[];
    const fields = this.db.query("SELECT * FROM card_fields ORDER BY position").all() as Row[];
    const byCard = new Map<string, CardField[]>();
    for (const f of fields) {
      const list = byCard.get(f.card_id as string) ?? [];
      list.push(toField(f));
      byCard.set(f.card_id as string, list);
    }
    return rows.map((r) => toCard(r, byCard.get(r.id as string) ?? []));
  }

  card(id: string): Card {
    const row = this.db.query("SELECT * FROM cards WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFoundError("card");
    const fields = (this.db.query("SELECT * FROM card_fields WHERE card_id = ? ORDER BY position").all(id) as Row[]).map(toField);
    return toCard(row, fields);
  }

  /** A new card with its default fields (empty unless given) and any custom ones. */
  createCard(raw: Row): Card {
    const name = cleanName(raw.name);
    const id = newId();
    const at = now();
    const given = Array.isArray(raw.fields) ? (raw.fields as Row[]).map(fieldInput) : [];
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO cards (id, name, is_persona, is_character, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, name, raw.isPersona === true ? 1 : 0, raw.isCharacter === false ? 0 : 1, at, at);
      const insert = this.db.query("INSERT INTO card_fields (id, card_id, key, title, content, position) VALUES (?, ?, ?, ?, ?, ?)");
      let position = 0;
      for (const d of DEFAULT_FIELDS) {
        const content = given.filter((g) => g.key === d.key).map((g) => g.content).join("\n\n");
        insert.run(newId(), id, d.key, d.title, content, position++);
      }
      for (const g of given.filter((g) => g.key === "custom")) insert.run(newId(), id, "custom", g.title, g.content, position++);
    })();
    return this.card(id);
  }

  /**
   * Change a card: its name, switches, and fields. `fields`, when given, is
   * the whole list in order: default fields are matched by key and keep
   * their ids, custom fields by id (new ones have none), and custom fields
   * left out are removed.
   */
  updateCard(id: string, raw: Row): Card {
    const card = this.card(id);
    this.db.transaction(() => {
      const name = raw.name !== undefined ? cleanName(raw.name) : card.name;
      const isPersona = raw.isPersona !== undefined ? raw.isPersona === true : card.isPersona;
      const isCharacter = raw.isCharacter !== undefined ? raw.isCharacter === true : card.isCharacter;
      this.db.query("UPDATE cards SET name = ?, is_persona = ?, is_character = ?, updated_at = ? WHERE id = ?").run(name, isPersona ? 1 : 0, isCharacter ? 1 : 0, now(), id);
      if (Array.isArray(raw.fields)) {
        const incoming = (raw.fields as Row[]).map((f) => ({ ...fieldInput(f), id: typeof f.id === "string" ? f.id : "" }));
        const keep = new Set<string>();
        const update = this.db.query("UPDATE card_fields SET title = ?, content = ?, position = ? WHERE id = ? AND card_id = ?");
        const insert = this.db.query("INSERT INTO card_fields (id, card_id, key, title, content, position) VALUES (?, ?, ?, ?, ?, ?)");
        let position = 0;
        // Default fields always exist, in their own order, first.
        for (const d of DEFAULT_FIELDS) {
          const existing = card.fields.find((f) => f.key === d.key)!;
          const given = incoming.find((f) => f.key === d.key);
          update.run(d.title, given ? given.content : existing.content, position++, existing.id, id);
          keep.add(existing.id);
        }
        for (const f of incoming.filter((f) => f.key === "custom")) {
          const existing = card.fields.find((c) => c.id === f.id && c.key === "custom");
          if (existing) {
            update.run(f.title, f.content, position++, existing.id, id);
            keep.add(existing.id);
          } else {
            const fid = newId();
            insert.run(fid, id, "custom", f.title, f.content, position++);
            keep.add(fid);
          }
        }
        for (const f of card.fields) if (!keep.has(f.id)) this.db.query("DELETE FROM card_fields WHERE id = ?").run(f.id);
      }
    })();
    return this.card(id);
  }

  deleteCard(id: string): void {
    this.card(id);
    this.db.query("DELETE FROM cards WHERE id = ?").run(id);
  }

  importCards(parsed: ParsedCard[]): Card[] {
    if (parsed.length === 0) throw new ValidationError("No cards found. Each card starts with a line like `# Name`.");
    return this.db.transaction(() => parsed.map((p) => this.createCard({ name: p.name, fields: p.fields })))();
  }

  // --------------------------------------------------------------- chats

  chats(): Chat[] {
    const rows = this.db.query("SELECT * FROM chats ORDER BY updated_at DESC").all() as Row[];
    return rows.map((r) => this.toChat(r));
  }

  chat(id: string): Chat {
    const row = this.db.query("SELECT * FROM chats WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFoundError("chat");
    return this.toChat(row);
  }

  private toChat(row: Row): Chat {
    const cast = (this.db.query("SELECT card_id FROM chat_cast WHERE chat_id = ? ORDER BY position").all(row.id as string) as { card_id: string }[]).map(
      (c) => c.card_id,
    );
    return { id: row.id as string, name: row.name as string, cast, createdAt: row.created_at as string, updatedAt: row.updated_at as string };
  }

  createChat(raw: Row): Chat {
    const id = newId();
    const at = now();
    this.db.query("INSERT INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, raw.name ? cleanName(raw.name) : "New chat", at, at);
    if (raw.cast !== undefined) this.setCast(id, raw.cast);
    return this.chat(id);
  }

  updateChat(id: string, raw: Row): Chat {
    const chat = this.chat(id);
    if (raw.name !== undefined) this.db.query("UPDATE chats SET name = ? WHERE id = ?").run(cleanName(raw.name), id);
    if (raw.cast !== undefined) this.setCast(id, raw.cast);
    void chat;
    return this.chat(id);
  }

  /** Replace a chat's cast with these card ids, in this order. */
  private setCast(chatId: string, raw: unknown): void {
    if (!Array.isArray(raw) || raw.some((c) => typeof c !== "string")) throw new ValidationError("The cast must be a list of card ids.");
    const ids = [...new Set(raw as string[])];
    for (const cardId of ids) this.card(cardId);
    this.db.transaction(() => {
      this.db.query("DELETE FROM chat_cast WHERE chat_id = ?").run(chatId);
      const insert = this.db.query("INSERT INTO chat_cast (chat_id, card_id, position) VALUES (?, ?, ?)");
      ids.forEach((cardId, i) => insert.run(chatId, cardId, i));
    })();
  }

  deleteChat(id: string): void {
    this.chat(id);
    this.db.query("DELETE FROM chats WHERE id = ?").run(id);
  }

  private touch(chatId: string): void {
    this.db.query("UPDATE chats SET updated_at = ? WHERE id = ?").run(now(), chatId);
  }

  // ------------------------------------------------------------ messages

  messages(chatId: string): Message[] {
    this.chat(chatId);
    return (this.db.query("SELECT * FROM messages WHERE chat_id = ? ORDER BY seq").all(chatId) as Row[]).map(toMessage);
  }

  message(id: string): Message {
    const row = this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFoundError("message");
    return toMessage(row);
  }

  addMessage(input: { chatId: string; role: "user" | "assistant"; author: string; content: string; profileId?: string; model?: string }): Message {
    this.chat(input.chatId);
    const id = newId();
    const seq = (this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE chat_id = ?").get(input.chatId) as { n: number }).n;
    this.db
      .query("INSERT INTO messages (id, chat_id, seq, role, author, swipes, swipe_index, profile_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)")
      .run(id, input.chatId, seq, input.role, input.author, JSON.stringify([input.content]), input.profileId ?? "", input.model ?? "", now());
    this.touch(input.chatId);
    return this.message(id);
  }

  /** Change the version shown. */
  editMessage(id: string, content: unknown): Message {
    if (typeof content !== "string" || content.trim() === "") throw new ValidationError("A message can't be empty.");
    const m = this.message(id);
    const swipes = [...m.swipes];
    swipes[m.swipeIndex] = content;
    this.db.query("UPDATE messages SET swipes = ?, edited_at = ? WHERE id = ?").run(JSON.stringify(swipes), now(), id);
    return this.message(id);
  }

  /** Add a version (a regenerated reply) and show it. */
  addSwipe(id: string, content: string, profileId: string, model: string): Message {
    const m = this.message(id);
    const swipes = [...m.swipes, content];
    this.db.query("UPDATE messages SET swipes = ?, swipe_index = ?, profile_id = ?, model = ?, edited_at = NULL WHERE id = ?").run(JSON.stringify(swipes), swipes.length - 1, profileId, model, id);
    this.touch(m.chatId);
    return this.message(id);
  }

  /** Show another version. */
  showSwipe(id: string, index: unknown): Message {
    const m = this.message(id);
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= m.swipes.length) throw new ValidationError("There's no version with that number.");
    this.db.query("UPDATE messages SET swipe_index = ? WHERE id = ?").run(index, id);
    return this.message(id);
  }

  deleteMessage(id: string): void {
    const m = this.message(id);
    this.db.query("DELETE FROM messages WHERE id = ?").run(id);
    this.touch(m.chatId);
  }
}

// ---------------------------------------------------------------- rows

function toProfile(r: Row): Profile {
  return {
    id: r.id as string,
    name: r.name as string,
    provider: r.provider as ProviderId,
    model: r.model as string,
    temperature: r.temperature as number,
    maxTokens: r.max_tokens as number,
    topP: (r.top_p as number | null) ?? null,
    minP: (r.min_p as number | null) ?? null,
    reasoningEffort: (r.reasoning_effort as ReasoningEffort | null) ?? null,
    extraParams: r.extra_params as string,
    position: r.position as number,
    createdAt: r.created_at as string,
  };
}

function toField(r: Row): CardField {
  return { id: r.id as string, key: r.key as FieldKey, title: r.title as string, content: r.content as string, position: r.position as number };
}

function toCard(r: Row, fields: CardField[]): Card {
  return {
    id: r.id as string,
    name: r.name as string,
    isPersona: r.is_persona === 1,
    isCharacter: r.is_character === 1,
    fields,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toMessage(r: Row): Message {
  const swipes = JSON.parse(r.swipes as string) as string[];
  const swipeIndex = Math.min(r.swipe_index as number, swipes.length - 1);
  return {
    id: r.id as string,
    chatId: r.chat_id as string,
    role: r.role as "user" | "assistant",
    author: r.author as string,
    content: swipes[swipeIndex] ?? "",
    swipes,
    swipeIndex,
    profileId: r.profile_id as string,
    model: r.model as string,
    createdAt: r.created_at as string,
    editedAt: (r.edited_at as string | null) ?? null,
  };
}

// ---------------------------------------------------------- validation

function cleanName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError("A name is required.");
  if (value.length > 200) throw new ValidationError("That name is too long (200 characters at most).");
  return value.trim();
}

function fieldInput(raw: Row): { key: FieldKey; title: string; content: string } {
  const key = raw.key ?? "custom";
  if (!["description", "advanced", "system", "custom"].includes(key as string)) throw new ValidationError("Unknown field kind.");
  if (typeof raw.content !== "string") throw new ValidationError("A field's content must be text.");
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : key === "custom" ? "" : (key as string);
  if (key === "custom" && !title) throw new ValidationError("A custom field needs a title.");
  return { key: key as FieldKey, title, content: raw.content };
}

const PROVIDERS = ["nanogpt", "vertex"];
const EFFORTS = ["none", "low", "medium", "high"];

function profileFields(raw: Row, creating: boolean): Partial<Profile> {
  const out: Partial<Profile> = {};
  if (raw.name !== undefined || creating) out.name = raw.name === undefined ? "New profile" : cleanName(raw.name);
  if (raw.provider !== undefined) {
    if (!PROVIDERS.includes(raw.provider as string)) throw new ValidationError("The provider must be nanogpt or vertex.");
    out.provider = raw.provider as ProviderId;
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string") throw new ValidationError("The model must be text.");
    out.model = raw.model.trim();
  }
  const num = (key: string, min: number, max: number, nullable: boolean) => {
    const v = raw[key];
    if (v === undefined) return;
    if (v === null || v === "") {
      if (!nullable) throw new ValidationError(`${key} is required.`);
      (out as Row)[key] = null;
      return;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${key} must be between ${min} and ${max}.`);
    (out as Row)[key] = n;
  };
  num("temperature", 0, 2, false);
  num("maxTokens", 1, 200000, false);
  num("topP", 0, 1, true);
  num("minP", 0, 1, true);
  if (out.maxTokens !== undefined) out.maxTokens = Math.round(out.maxTokens);
  if (raw.reasoningEffort !== undefined) {
    if (raw.reasoningEffort !== null && raw.reasoningEffort !== "" && !EFFORTS.includes(raw.reasoningEffort as string)) throw new ValidationError("Unknown reasoning effort.");
    out.reasoningEffort = raw.reasoningEffort ? (raw.reasoningEffort as ReasoningEffort) : null;
  }
  if (raw.extraParams !== undefined) {
    if (typeof raw.extraParams !== "string") throw new ValidationError("Extra parameters must be JSON text.");
    const text = raw.extraParams.trim();
    if (text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ValidationError('Extra parameters must be a JSON object, like {"top_k": 40}.');
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ValidationError('Extra parameters must be a JSON object, like {"top_k": 40}.');
    }
    out.extraParams = text;
  }
  return out;
}
