/**
 * The database layout. Anoesia uses SQLite through Bun (`data/anoesia.db`),
 * like Amaedori: nothing to install or run alongside the server.
 *
 *   cards ──< card_fields
 *   chats ──< chat_cast >── cards
 *   chats ──< messages
 *   chats ──< prompt_blocks
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

  // 3: the agent. Its files, sessions, messages and change log.
  `
  CREATE TABLE agent_files (
    path TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT,
    tool_call_id TEXT,
    tool_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX agent_messages_session ON agent_messages(session_id, seq);
  CREATE TABLE agent_edits (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    path TEXT NOT NULL,
    target TEXT NOT NULL,
    before TEXT,
    after TEXT,
    meta TEXT,
    created_at TEXT NOT NULL,
    reverted_at TEXT
  );
  CREATE INDEX agent_edits_time ON agent_edits(created_at);
  `,
  // 4: card colours (a preset name or a hex), and the last custom one picked.
  `
  ALTER TABLE cards ADD COLUMN colour TEXT NOT NULL DEFAULT 'violet';
  ALTER TABLE cards ADD COLUMN custom_colour TEXT NOT NULL DEFAULT '';
  `,
  // 5: background photos you upload (the files are in the data folder's photos/).
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

  // 6: each chat's own agent. A session is the main agent's, or bound to
  // one chat (its sub-agent, with its own personality and notebook).
  `
  ALTER TABLE agent_sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'main' CHECK (scope IN ('main', 'chat'));
  `,

  // 7: cast presence and chat notes. A cast member can be offstage in a
  // chat (only its Description is sent). Blocks gain the 'note' kind for
  // the chat's own notes ("Right now", "Who knows what"); SQLite can't
  // change a CHECK, so the blocks table is rebuilt (nothing points at it).
  `
  ALTER TABLE chat_cast ADD COLUMN onstage INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE prompt_blocks_v7 (
    id       TEXT PRIMARY KEY,
    chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL CHECK (kind IN ('main', 'text', 'field', 'history', 'note')),
    card_id  TEXT REFERENCES cards(id) ON DELETE CASCADE,
    field_id TEXT REFERENCES card_fields(id) ON DELETE CASCADE,
    title    TEXT NOT NULL DEFAULT '',
    content  TEXT NOT NULL DEFAULT '',    -- for 'text' and 'note' blocks; linked blocks read their source
    role     TEXT NOT NULL DEFAULT 'system' CHECK (role IN ('system', 'user', 'assistant')),
    enabled  INTEGER NOT NULL DEFAULT 1,
    depth    INTEGER,
    position INTEGER NOT NULL
  );
  INSERT INTO prompt_blocks_v7 (id, chat_id, kind, card_id, field_id, title, content, role, enabled, depth, position)
    SELECT id, chat_id, kind, card_id, field_id, title, content, role, enabled, depth, position FROM prompt_blocks;
  DROP TABLE prompt_blocks;
  ALTER TABLE prompt_blocks_v7 RENAME TO prompt_blocks;
  CREATE INDEX prompt_blocks_chat ON prompt_blocks(chat_id, position);
  `,

  // 8: a reply's reasoning. A thinking model's reasoning for each version,
  // a JSON array beside swipes ("" where there was none). Kept to read, never
  // sent back to the model.
  `
  ALTER TABLE messages ADD COLUMN reasonings TEXT NOT NULL DEFAULT '[]';
  `,
];

/** Open (or create) the database at `path` and bring its layout up to date. */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  // The agent and lacquer branches both shipped a migration numbered 3
  // independently. Older local databases can therefore have either feature
  // set at user_version 3 or 4. Run only the shared foundation migrations
  // here, then reconcile the optional tables/columns by inspecting the schema.
  // This makes upgrades safe whichever branch created the existing database.
  const step = (i: number) =>
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  for (let i = version; i < Math.min(MIGRATIONS.length, 2); i++) step(i);
  db.transaction(() => {
    const columns = new Set((db.query("PRAGMA table_info(cards)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("colour")) db.exec("ALTER TABLE cards ADD COLUMN colour TEXT NOT NULL DEFAULT 'violet'");
    if (!columns.has("custom_colour")) db.exec("ALTER TABLE cards ADD COLUMN custom_colour TEXT NOT NULL DEFAULT ''");
    db.exec(`
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, ext TEXT NOT NULL, tint TEXT NOT NULL,
        position TEXT NOT NULL DEFAULT '50% 50%', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_files (
        path TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, turn_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL DEFAULT '', tool_calls TEXT, tool_call_id TEXT, tool_name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_messages_session ON agent_messages(session_id, seq);
      CREATE TABLE IF NOT EXISTS agent_edits (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, path TEXT NOT NULL,
        target TEXT NOT NULL, before TEXT, after TEXT, meta TEXT, created_at TEXT NOT NULL, reverted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_edits_time ON agent_edits(created_at);
    `);
    db.exec(`PRAGMA user_version = ${Math.max(version, 5)}`);
  })();
  // Everything after 5 is ordinary again: each new migration runs once.
  for (let i = Math.max(version, 5); i < MIGRATIONS.length; i++) step(i);
  return db;
}
