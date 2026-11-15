/**
 * The database layout. Anoesia uses SQLite through Bun (`data/anoesia.db`),
 * like Amaedori: nothing to install or run alongside the server.
 *
 *   cards ──< card_fields
 *   chats ──< chat_cast >── cards
 *   chats ──< messages
 *
 * Each step in MIGRATIONS moves the layout one version on. SQLite keeps the
 * version in the file (`user_version`), so an old database is upgraded on
 * start. Never edit a released step: add a new one to the end.
 */

import { Database } from "bun:sqlite";

export const MIGRATIONS: string[] = [
  // 1: the starting layout.
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL            -- JSON
  );

  CREATE TABLE profiles (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    provider         TEXT NOT NULL DEFAULT 'nanogpt' CHECK (provider IN ('nanogpt', 'vertex')),
    model            TEXT NOT NULL,
    temperature      REAL NOT NULL DEFAULT 1,
    max_tokens       INTEGER NOT NULL DEFAULT 1024,
    top_p            REAL,
    min_p            REAL,
    reasoning_effort TEXT,
    extra_params     TEXT NOT NULL DEFAULT '',
    position         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL
  );

  CREATE TABLE cards (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    is_persona   INTEGER NOT NULL DEFAULT 0,
    is_character INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE card_fields (
    id       TEXT PRIMARY KEY,
    card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    key      TEXT NOT NULL CHECK (key IN ('description', 'advanced', 'system', 'custom')),
    title    TEXT NOT NULL,
    content  TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL
  );
  CREATE INDEX card_fields_card ON card_fields(card_id, position);

  CREATE TABLE chats (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE chat_cast (
    chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (chat_id, card_id)
  );

  CREATE TABLE messages (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    author      TEXT NOT NULL,         -- 'user', 'narrator', or a card id
    swipes      TEXT NOT NULL,         -- JSON array of versions
    swipe_index INTEGER NOT NULL DEFAULT 0,
    profile_id  TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    edited_at   TEXT
  );
  CREATE INDEX messages_chat ON messages(chat_id, seq);
  `,

  // 2: the prompts page. Each chat's prompt is its own list of blocks:
  // the main prompt (linked to settings), card fields (linked to the field),
  // its own text blocks, and the chat history. Plus macro variables.
  `
  CREATE TABLE prompt_blocks (
    id       TEXT PRIMARY KEY,
    chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL CHECK (kind IN ('main', 'text', 'field', 'history')),
    card_id  TEXT REFERENCES cards(id) ON DELETE CASCADE,
    field_id TEXT REFERENCES card_fields(id) ON DELETE CASCADE,
    title    TEXT NOT NULL DEFAULT '',
    content  TEXT NOT NULL DEFAULT '',    -- only for 'text' blocks; linked blocks read their source
    role     TEXT NOT NULL DEFAULT 'system' CHECK (role IN ('system', 'user', 'assistant')),
    enabled  INTEGER NOT NULL DEFAULT 1,
    depth    INTEGER,                     -- null: where it is; n: inside the chat, n messages from the end
    position INTEGER NOT NULL
  );
  CREATE INDEX prompt_blocks_chat ON prompt_blocks(chat_id, position);

  -- Macro variables: scope is a chat id, or 'global'.
  CREATE TABLE macro_vars (
    scope TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );
  `,

  // 3: card colours (a preset name or a hex), and the last custom one picked.
  `
  ALTER TABLE cards ADD COLUMN colour TEXT NOT NULL DEFAULT 'violet';
  ALTER TABLE cards ADD COLUMN custom_colour TEXT NOT NULL DEFAULT '';
  `,
  // 4: background photos you upload (the files are in the data folder's photos/).
  `
  CREATE TABLE photos (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    ext        TEXT NOT NULL,
    tint       TEXT NOT NULL,
    position   TEXT NOT NULL DEFAULT '50% 50%',
    created_at TEXT NOT NULL
  );
  `,
];

/** Open (or create) the database at `path` and bring its layout up to date. */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  return db;
}
