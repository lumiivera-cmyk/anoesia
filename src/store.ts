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
import type { Background, BlockKind, Card, CardField, Chat, FieldKey, Finish, Message, Photo, Profile, PromptBlock, ProviderId, ReasoningEffort, Settings } from "./types.ts";

const now = () => new Date().toISOString();

export const DEFAULT_BACKGROUND: Background = { photo: "none", finish: "tamenuri", tint: 0.6, dim: 0.3, window: null };

const DEFAULT_SETTINGS: Settings = {
  rpProfileId: "",
  mainPrompt: DEFAULT_MAIN_PROMPT,
  background: DEFAULT_BACKGROUND,
  agentProfileId: "",
};

export const PHOTO_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const POSITION = /^\d{1,3}% \d{1,3}%$/;
const FINISHES: Finish[] = ["roiro", "tamenuri", "shunkei"];
const PRESET_COLOURS = ["violet", "blue", "pink"];
const HEX = /^#[0-9A-F]{6}$/;

type Row = Record<string, unknown>;

export class Store {
  constructor(readonly db: Database) {}

  // ------------------------------------------------------------ photos

  photos(): Photo[] {
    return (this.db.query("SELECT * FROM photos ORDER BY created_at, id").all() as Row[]).map(toPhoto);
  }

  findPhoto(id: string): (Photo & { ext: string }) | null {
    const row = this.db.query("SELECT * FROM photos WHERE id = ?").get(id) as Row | null;
    return row ? { ...toPhoto(row), ext: String(row.ext) } : null;
  }

  /** Record a photo whose file the caller saves as photos/<id>.<ext>. */
  addPhoto(raw: { name?: unknown; ext: string; tint?: unknown; position?: unknown }): Photo {
    if (!PHOTO_TYPES[raw.ext]) throw new ValidationError("A photo is a JPEG, PNG or WebP image.");
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 60) : "my photo";
    const tint = typeof raw.tint === "string" && HEX.test(raw.tint.toUpperCase()) ? raw.tint.toUpperCase() : "#15131C";
    const position = typeof raw.position === "string" && POSITION.test(raw.position) ? raw.position : "50% 50%";
    const id = newId();
    this.db.query("INSERT INTO photos (id, name, ext, tint, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, raw.ext, tint, position, now());
    return toPhoto(this.db.query("SELECT * FROM photos WHERE id = ?").get(id) as Row);
  }

  /** Forget a photo (the caller deletes its file). The background goes back to none if it was showing. */
  deletePhoto(id: string): { ext: string } {
    const photo = this.findPhoto(id);
    if (!photo) throw new NotFoundError("photo");
    this.db.query("DELETE FROM photos WHERE id = ?").run(id);
    return { ext: photo.ext };
  }

  // ------------------------------------------------------------ settings

  settings(): Settings {
    const rows = this.db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const row of rows) if (row.key in out) (out as unknown as Row)[row.key] = JSON.parse(row.value);
    out.background = { ...DEFAULT_BACKGROUND, ...out.background };
    // A photo that's gone (or one of the old built-in names) shows as none.
    if (out.background.photo !== "none" && !this.findPhoto(out.background.photo)) out.background.photo = "none";
    if (out.rpProfileId && !this.findProfile(out.rpProfileId)) out.rpProfileId = "";
    if (out.agentProfileId && !this.findProfile(out.agentProfileId)) out.agentProfileId = "";
    return out;
  }

  updateSettings(raw: Row): Settings {
    const clean: Partial<Settings> = {};
    if (raw.rpProfileId !== undefined) {
      if (typeof raw.rpProfileId !== "string") throw new ValidationError("rpProfileId must be text");
      if (raw.rpProfileId && !this.findProfile(raw.rpProfileId)) throw new NotFoundError("profile");
      clean.rpProfileId = raw.rpProfileId;
    }
    if (raw.agentProfileId !== undefined) {
      if (typeof raw.agentProfileId !== "string") throw new ValidationError("agentProfileId must be text");
      if (raw.agentProfileId && !this.findProfile(raw.agentProfileId)) throw new NotFoundError("profile");
      clean.agentProfileId = raw.agentProfileId;
    }
    if (raw.mainPrompt !== undefined) {
      if (typeof raw.mainPrompt !== "string") throw new ValidationError("The main prompt must be text.");
      clean.mainPrompt = raw.mainPrompt;
    }
    if (raw.background !== undefined) {
      clean.background = backgroundInput(raw.background, this.settings().background);
      if (clean.background.photo !== "none" && !this.findPhoto(clean.background.photo)) throw new NotFoundError("photo");
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
        .query("INSERT INTO cards (id, name, is_persona, is_character, colour, custom_colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, name, raw.isPersona === true ? 1 : 0, raw.isCharacter === false ? 0 : 1, raw.colour === undefined ? "violet" : colourInput(raw.colour), "", at, at);
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
   * Change a card: its name, switches, colour and fields. `fields`, when
   * given, is the whole list in the order they're sent: default fields are
   * matched by key and keep their ids (they can move but never go), custom
   * fields by id (new ones have none), and custom fields left out are
   * removed. A new order also reorders the card's folder in every chat
   * where its fields still sit together; a field a chat moved out stays put.
   */
  updateCard(id: string, raw: Row): Card {
    const card = this.card(id);
    this.db.transaction(() => {
      const name = raw.name !== undefined ? cleanName(raw.name) : card.name;
      const isPersona = raw.isPersona !== undefined ? raw.isPersona === true : card.isPersona;
      const isCharacter = raw.isCharacter !== undefined ? raw.isCharacter === true : card.isCharacter;
      const colour = raw.colour !== undefined ? colourInput(raw.colour) : card.colour;
      // A custom colour is remembered after switching back to a preset.
      let customColour = raw.customColour !== undefined ? (raw.customColour === "" ? "" : colourInput(raw.customColour)) : card.customColour;
      if (colour.startsWith("#")) customColour = colour;
      if (customColour && !customColour.startsWith("#")) throw new ValidationError("A custom colour is a hex like #FFB547.");
      this.db
        .query("UPDATE cards SET name = ?, is_persona = ?, is_character = ?, colour = ?, custom_colour = ?, updated_at = ? WHERE id = ?")
        .run(name, isPersona ? 1 : 0, isCharacter ? 1 : 0, colour, customColour, now(), id);
      if (Array.isArray(raw.fields)) {
        const incoming = (raw.fields as Row[]).map((f) => ({ ...fieldInput(f), id: typeof f.id === "string" ? f.id : "" }));
        const keep = new Set<string>();
        const update = this.db.query("UPDATE card_fields SET title = ?, content = ?, position = ? WHERE id = ? AND card_id = ?");
        const insert = this.db.query("INSERT INTO card_fields (id, card_id, key, title, content, position) VALUES (?, ?, ?, ?, ?, ?)");
        // Default fields that weren't sent keep their text and their old place; the rest go in the order given.
        const list = [...incoming];
        for (const existing of card.fields) {
          if (existing.key === "custom" || incoming.some((f) => f.key === existing.key)) continue;
          list.splice(Math.min(existing.position, list.length), 0, { key: existing.key, title: existing.title, content: existing.content, id: "" });
        }
        let position = 0;
        const seen = new Set<string>();
        for (const f of list) {
          if (f.key !== "custom") {
            if (seen.has(f.key)) throw new ValidationError(`The ${f.key} field is listed twice.`);
            seen.add(f.key);
            const d = DEFAULT_FIELDS.find((x) => x.key === f.key)!;
            const existing = card.fields.find((x) => x.key === f.key)!;
            update.run(d.title, f.content, position++, existing.id, id);
            keep.add(existing.id);
            continue;
          }
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
        this.reorderFolders(id);
      }
    })();
    return this.card(id);
  }

  /** In every chat, put a card's run of field blocks in the card's field order. */
  private reorderFolders(cardId: string): void {
    const order = new Map((this.db.query("SELECT id, position FROM card_fields WHERE card_id = ?").all(cardId) as { id: string; position: number }[]).map((f) => [f.id, f.position]));
    const chats = this.db.query("SELECT DISTINCT chat_id FROM prompt_blocks WHERE card_id = ?").all(cardId) as { chat_id: string }[];
    const update = this.db.query("UPDATE prompt_blocks SET position = ? WHERE id = ?");
    for (const { chat_id } of chats) {
      const rows = this.db.query("SELECT id, card_id, field_id, position FROM prompt_blocks WHERE chat_id = ? ORDER BY position").all(chat_id) as Row[];
      // The card's longest run of blocks is its folder.
      let best: [number, number] = [0, 0];
      for (let i = 0; i < rows.length; ) {
        if (rows[i]!.card_id !== cardId) {
          i++;
          continue;
        }
        let j = i;
        while (j < rows.length && rows[j]!.card_id === cardId) j++;
        if (j - i > best[1] - best[0]) best = [i, j];
        i = j;
      }
      const run = rows.slice(best[0], best[1]);
      const positions = run.map((r) => r.position as number);
      run.sort((a, b) => (order.get(a.field_id as string) ?? 0) - (order.get(b.field_id as string) ?? 0)).forEach((r, k) => update.run(positions[k]!, r.id as string));
    }
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
    this.db.query("DELETE FROM macro_vars WHERE scope = ?").run(id);
  }

  private touch(chatId: string): void {
    this.db.query("UPDATE chats SET updated_at = ? WHERE id = ?").run(now(), chatId);
  }

  // -------------------------------------------------------- prompt blocks

  /**
   * A chat's prompt blocks, in order, made up to date first: a new chat
   * gets the main prompt, each cast card's fields in cast order, and the
   * chat history; after that, a card added to the cast gets its fields
   * just before the history, a new field on a card goes after that card's
   * last block, and a card taken out of the cast loses its blocks.
   */
  blocks(chatId: string): PromptBlock[] {
    const chat = this.chat(chatId);
    this.db.transaction(() => this.syncBlocks(chat))();
    const settings = this.settings();
    const rows = this.db
      .query(
        `SELECT b.*, f.title AS field_title, f.content AS field_content
         FROM prompt_blocks b LEFT JOIN card_fields f ON f.id = b.field_id
         WHERE b.chat_id = ? ORDER BY b.position`,
      )
      .all(chatId) as Row[];
    return rows.map((r) => toBlock(r, settings.mainPrompt));
  }

  block(id: string): PromptBlock {
    const row = this.db.query("SELECT chat_id FROM prompt_blocks WHERE id = ?").get(id) as { chat_id: string } | null;
    if (!row) throw new NotFoundError("block");
    return this.blocks(row.chat_id).find((b) => b.id === id)!;
  }

  private syncBlocks(chat: Chat): void {
    const rows = () => this.db.query("SELECT id, kind, card_id, field_id FROM prompt_blocks WHERE chat_id = ? ORDER BY position").all(chat.id) as Row[];
    const insert = this.db.query("INSERT INTO prompt_blocks (id, chat_id, kind, card_id, field_id, title, content, role, position) VALUES (?, ?, ?, ?, ?, '', '', 'system', ?)");
    let blocks = rows();
    if (blocks.length === 0) {
      let position = 0;
      insert.run(newId(), chat.id, "main", null, null, position++);
      for (const cardId of chat.cast) for (const f of this.card(cardId).fields) insert.run(newId(), chat.id, "field", cardId, f.id, position++);
      this.db.query("INSERT INTO prompt_blocks (id, chat_id, kind, role, position) VALUES (?, ?, 'history', 'user', ?)").run(newId(), chat.id, position);
      return;
    }
    // Cards that left the cast take their blocks with them.
    const inCast = new Set(chat.cast);
    for (const b of blocks) if (b.kind === "field" && !inCast.has(b.card_id as string)) this.db.query("DELETE FROM prompt_blocks WHERE id = ?").run(b.id as string);
    blocks = rows();
    // The main prompt and the history always exist once.
    if (!blocks.some((b) => b.kind === "main")) blocks.unshift({ id: newId(), kind: "main", card_id: null, field_id: null, new: true });
    if (!blocks.some((b) => b.kind === "history")) blocks.push({ id: newId(), kind: "history", card_id: null, field_id: null, new: true });
    // Fields with no block yet.
    for (const cardId of chat.cast) {
      for (const f of this.card(cardId).fields) {
        if (blocks.some((b) => b.field_id === f.id)) continue;
        const lastOfCard = blocks.map((b) => b.card_id).lastIndexOf(cardId);
        const at = lastOfCard >= 0 ? lastOfCard + 1 : blocks.findIndex((b) => b.kind === "history");
        blocks.splice(at, 0, { id: newId(), kind: "field", card_id: cardId, field_id: f.id, new: true });
      }
    }
    const update = this.db.query("UPDATE prompt_blocks SET position = ? WHERE id = ?");
    blocks.forEach((b, i) => {
      if (b.new) {
        if (b.kind === "history") this.db.query("INSERT INTO prompt_blocks (id, chat_id, kind, role, position) VALUES (?, ?, 'history', 'user', ?)").run(b.id as string, chat.id, i);
        else insert.run(b.id as string, chat.id, b.kind as string, (b.card_id as string | null) ?? null, (b.field_id as string | null) ?? null, i);
      } else update.run(i, b.id as string);
    });
  }

  /** A new text block of the chat's own, just before the chat history. */
  createBlock(chatId: string, raw: Row): PromptBlock {
    const blocks = this.blocks(chatId);
    const at = blocks.findIndex((b) => b.kind === "history");
    const id = newId();
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 200) : "New block";
    if (raw.content !== undefined && typeof raw.content !== "string") throw new ValidationError("A block's text must be text.");
    const role = raw.role === undefined ? "system" : checkRole(raw.role);
    const depth = raw.depth === undefined || raw.depth === null ? null : Number(raw.depth);
    if (depth !== null && (!Number.isInteger(depth) || depth < 0 || depth > 999)) throw new ValidationError("Depth is a whole number of messages from the end, 0 to 999.");
    this.db.transaction(() => {
      this.db.query("UPDATE prompt_blocks SET position = position + 1 WHERE chat_id = ? AND position >= ?").run(chatId, at);
      this.db.query("INSERT INTO prompt_blocks (id, chat_id, kind, title, content, role, depth, position) VALUES (?, ?, 'text', ?, ?, ?, ?, ?)").run(id, chatId, title, (raw.content as string) ?? "", role, depth, at);
    })();
    return this.block(id);
  }

  /**
   * Change a block. Its text is its source's: editing a card field's block
   * edits the card, and the main prompt's edits the main prompt in
   * settings, shared by every chat.
   */
  updateBlock(id: string, raw: Row): PromptBlock {
    const block = this.block(id);
    this.db.transaction(() => {
      if (raw.content !== undefined) {
        if (typeof raw.content !== "string") throw new ValidationError("A block's text must be text.");
        if (block.kind === "text") this.db.query("UPDATE prompt_blocks SET content = ? WHERE id = ?").run(raw.content, id);
        else if (block.kind === "field") {
          this.db.query("UPDATE card_fields SET content = ? WHERE id = ?").run(raw.content, block.fieldId);
          this.db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), block.cardId);
        } else if (block.kind === "main") this.updateSettings({ mainPrompt: raw.content });
        else throw new ValidationError("The chat history's text is the chat itself.");
      }
      if (raw.title !== undefined) {
        if (block.kind !== "text") throw new ValidationError("Only your own blocks can be renamed here.");
        if (typeof raw.title !== "string" || !raw.title.trim()) throw new ValidationError("A block needs a title.");
        this.db.query("UPDATE prompt_blocks SET title = ? WHERE id = ?").run(raw.title.trim().slice(0, 200), id);
      }
      if (raw.role !== undefined) {
        if (block.kind === "history") throw new ValidationError("The chat history keeps each message's own role.");
        this.db.query("UPDATE prompt_blocks SET role = ? WHERE id = ?").run(checkRole(raw.role), id);
      }
      if (raw.enabled !== undefined) {
        if (typeof raw.enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
        if (block.kind === "history" && !raw.enabled) throw new ValidationError("The chat history can't be switched off.");
        this.db.query("UPDATE prompt_blocks SET enabled = ? WHERE id = ?").run(raw.enabled ? 1 : 0, id);
      }
      if (raw.depth !== undefined) {
        if (block.kind === "history") throw new ValidationError("The chat history can't go inside itself.");
        const depth = raw.depth === null || raw.depth === "" ? null : Number(raw.depth);
        if (depth !== null && (!Number.isInteger(depth) || depth < 0 || depth > 999)) throw new ValidationError("Depth is a whole number of messages from the end, 0 to 999.");
        this.db.query("UPDATE prompt_blocks SET depth = ? WHERE id = ?").run(depth, id);
      }
    })();
    return this.block(id);
  }

  /** Remove one of the chat's own text blocks. (Card fields leave with their card; the main prompt and history stay.) */
  deleteBlock(id: string): void {
    const block = this.block(id);
    if (block.kind !== "text") throw new ValidationError("Only your own blocks can be deleted. Switch this one off instead.");
    this.db.query("DELETE FROM prompt_blocks WHERE id = ?").run(id);
  }

  /** Put a chat's blocks in this order. `ids` must be every block, once. */
  orderBlocks(chatId: string, ids: unknown): PromptBlock[] {
    const blocks = this.blocks(chatId);
    if (!Array.isArray(ids) || ids.length !== blocks.length || new Set(ids).size !== ids.length || !blocks.every((b) => ids.includes(b.id))) {
      throw new ValidationError("The new order has to list every block once. Reload and try again.");
    }
    const update = this.db.query("UPDATE prompt_blocks SET position = ? WHERE id = ?");
    this.db.transaction(() => (ids as string[]).forEach((id, i) => update.run(i, id)))();
    return this.blocks(chatId);
  }

  // ------------------------------------------------------------ variables

  /** Macro variables for a chat id, or `global`. */
  vars(scope: string): Record<string, string> {
    const rows = this.db.query("SELECT key, value FROM macro_vars WHERE scope = ?").all(scope) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  saveVars(scope: string, vars: Record<string, string>): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM macro_vars WHERE scope = ?").run(scope);
      const insert = this.db.query("INSERT INTO macro_vars (scope, key, value) VALUES (?, ?, ?)");
      for (const [k, v] of Object.entries(vars)) insert.run(scope, k, v);
    })();
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
    colour: (r.colour as string | undefined) ?? "violet",
    customColour: (r.custom_colour as string | undefined) ?? "",
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

function toBlock(r: Row, mainPrompt: string): PromptBlock {
  const kind = r.kind as BlockKind;
  const title = kind === "main" ? "Main prompt" : kind === "history" ? "Chat history" : kind === "field" ? (r.field_title as string) : (r.title as string);
  const content = kind === "main" ? mainPrompt : kind === "field" ? (r.field_content as string) : kind === "text" ? (r.content as string) : "";
  return {
    id: r.id as string,
    chatId: r.chat_id as string,
    kind,
    cardId: (r.card_id as string | null) ?? null,
    fieldId: (r.field_id as string | null) ?? null,
    title,
    content,
    role: r.role as PromptBlock["role"],
    enabled: r.enabled === 1,
    depth: (r.depth as number | null) ?? null,
    position: r.position as number,
  };
}

function checkRole(value: unknown): PromptBlock["role"] {
  if (value !== "system" && value !== "user" && value !== "assistant") throw new ValidationError("A role is system, user or assistant.");
  return value;
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

/** A preset colour name, or a hex (any case, with or without #), as `#RRGGBB`. */
function colourInput(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("A colour is violet, blue, pink or a hex like #FFB547.");
  if (PRESET_COLOURS.includes(value)) return value;
  const hex = `#${value.trim().replace(/^#/, "").toUpperCase()}`;
  if (!HEX.test(hex)) throw new ValidationError("A colour is violet, blue, pink or a hex like #FFB547.");
  return hex;
}

function backgroundInput(raw: unknown, current: Background): Background {
  if (typeof raw !== "object" || raw === null) throw new ValidationError("The background settings must be an object.");
  const b = raw as Row;
  const out: Background = { ...current };
  if (b.photo !== undefined) {
    if (typeof b.photo !== "string" || !b.photo) throw new ValidationError("The background photo is a photo's id, or none.");
    out.photo = b.photo;
  }
  if (b.finish !== undefined) {
    if (!FINISHES.includes(b.finish as Finish)) throw new ValidationError("The finish is roiro, tamenuri or shunkei.");
    out.finish = b.finish as Finish;
  }
  const range = (key: "tint" | "dim", min: number, max: number) => {
    if (b[key] === undefined) return;
    const n = Number(b[key]);
    if (typeof b[key] !== "number" || !Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${key} goes from ${min} to ${max}.`);
    out[key] = n;
  };
  range("tint", 0, 1);
  range("dim", 0, 0.8);
  if (b.window !== undefined) {
    if (b.window === null) out.window = null;
    else if (typeof b.window !== "number" || b.window < 0.3 || b.window > 0.95) throw new ValidationError("window goes from 0.3 to 0.95.");
    else out.window = b.window;
  }
  return out;
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

function toPhoto(row: Row): Photo {
  return { id: String(row.id), name: String(row.name), url: `media/${row.id}.${row.ext}`, tint: String(row.tint), position: String(row.position), createdAt: String(row.created_at) };
}
