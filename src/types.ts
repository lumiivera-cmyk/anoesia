/**
 * The shapes of everything Anoesia stores and sends.
 */

/** A message as sent to the model's API. */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** The API's message shape (kept as its own name so the lifted client reads the same as in Amaedori). */
export type ApiMessage = ChatMessage;

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/** Where a profile's model comes from. */
export type ProviderId = "nanogpt" | "vertex";

/** A connection profile: a model and its settings. */
export interface Profile {
  id: string;
  /** Your name for it, e.g. "Gemini, warm". */
  name: string;
  provider: ProviderId;
  /** The provider's model id, e.g. `zai-org/GLM-4.6` on nanoGPT, `google/gemini-2.5-pro` on Vertex AI. */
  model: string;
  temperature: number;
  /** Upper limit on one reply's length, in tokens. */
  maxTokens: number;
  topP: number | null;
  minP: number | null;
  reasoningEffort: ReasoningEffort | null;
  /** More request fields, as a JSON object in text (e.g. `{"top_k": 40}`), or "". */
  extraParams: string;
  position: number;
  createdAt: string;
}

/** The four fields every card has, plus custom ones. */
export type FieldKey = "description" | "advanced" | "system" | "custom";

/** One field of a card. Each becomes its own block on the prompts page (step 2). */
export interface CardField {
  id: string;
  key: FieldKey;
  /** "Description", "Advanced description", "System prompt", or a custom field's own title. */
  title: string;
  content: string;
  position: number;
}

/**
 * A card: a character, a persona (`isPersona`, "this is me"), or anything
 * else, like a world or a faction (`isCharacter` false).
 */
export interface Card {
  id: string;
  name: string;
  /** "This is me": the user's own character. Fills `{{user}}`. */
  isPersona: boolean;
  /**
   * Whether `{{cast}}` lists it. Off for cards that describe a place, a world
   * or a faction rather than someone to write.
   */
  isCharacter: boolean;
  /** Its bead: a preset (`violet`, `blue`, `pink`) or any colour as `#RRGGBB`. */
  colour: string;
  /** The last custom colour picked, kept after switching back to a preset ("" if none yet). */
  customColour: string;
  fields: CardField[];
  createdAt: string;
  updatedAt: string;
}

/** A chat and its cast, in prompt order. */
export interface Chat {
  id: string;
  name: string;
  /** The cards active in it, in the order their blocks go into the prompt. */
  cast: string[];
  createdAt: string;
  updatedAt: string;
}

/** Who wrote a message: `user`, `narrator`, or a card id (classic group chat, later). */
export type Author = string;

export interface Message {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  /** v1 always records `narrator` for replies and `user` for yours. */
  author: Author;
  /** The version shown: `swipes[swipeIndex]`. */
  content: string;
  /** Every version of this message (regenerating adds one). */
  swipes: string[];
  swipeIndex: number;
  /** The profile and model that wrote the version shown ("" for yours). */
  profileId: string;
  model: string;
  createdAt: string;
  editedAt: string | null;
}

/** App-wide settings. */
export interface Settings {
  /** The profile that writes replies. */
  rpProfileId: string;
  /** The main prompt: the first system block, with macros. */
  mainPrompt: string;
  /** The photo behind the app and how the lacquer meets it. */
  background: Background;
  /** The profile the agent thinks with (empty until one is picked). */
  agentProfileId: string;
}

/** A background photo you uploaded. The file is in the data folder, served at `url`. */
export interface Photo {
  id: string;
  name: string;
  /** Where the browser loads it: media/<id>.<ext>. */
  url: string;
  /** The dark colour the lacquer leans towards, worked out from the photo when it's added. */
  tint: string;
  /** How the photo is framed (CSS object-position). */
  position: string;
  createdAt: string;
}

/** Lacquer finishes: opaque, 72% with a blur, or 50% with a lighter blur. */
export type Finish = "roiro" | "tamenuri" | "shunkei";

export interface Background {
  /** An uploaded photo's id, or "none". */
  photo: string;
  finish: Finish;
  /** How far the photo's hue tints the lacquer, 0 to 1. */
  tint: number;
  /** How much the photo is darkened, 0 to 0.8. */
  dim: number;
  /** How dark the reading column is over the photo, 0.3 to 0.95; null for the default (0.72 wide, 0.7 on a phone). */
  window: number | null;
}

/** What a prompt block is. */
export type BlockKind = "main" | "text" | "field" | "history";

/** One block on a chat's prompts page. */
export interface PromptBlock {
  id: string;
  chatId: string;
  kind: BlockKind;
  /** For a field block: the card and the field it shows. */
  cardId: string | null;
  fieldId: string | null;
  /** A text block's own title; for linked blocks, the source's ("Description", "Main prompt"). */
  title: string;
  /** The text, read from its source for linked blocks. "" for the history block. */
  content: string;
  role: ChatMessage["role"];
  enabled: boolean;
  /** null: in its place in the list. A number: inside the chat history, that many messages from the end (0 = after the last). */
  depth: number | null;
  position: number;
}


// ------------------------------------------------------------------ agent

/** A tool call as the API writes it inside an assistant message. */
export interface ApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider metadata replayed as it came (Gemini thought signatures). */
  extra_content?: Record<string, unknown>;
}

/** A message in an agent conversation, as sent to the API. */
export type AgentApiMessage =
  | ChatMessage
  | { role: "assistant"; content: string | null; tool_calls: ApiToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

/** A conversation with the agent. Its messages are kept, so you can go back to one. */
export interface AgentSession {
  id: string;
  title: string;
  /** `main`: the main agent. `chat`: the open chat's own agent, bound to `chatId`. */
  scope: "main" | "chat";
  /** The chat that was open when you last wrote to it, or null. */
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One message in an agent session. */
export interface AgentMessage {
  id: string;
  sessionId: string;
  /** The turn it belongs to: your message and everything the agent did in reply. */
  turnId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** For an assistant message that called tools. */
  toolCalls: ApiToolCall[] | null;
  /** For a tool result: which call, and its tool. */
  toolCallId: string | null;
  toolName: string | null;
  createdAt: string;
}

/** One change the agent made, kept so it can be shown as a diff and undone. */
export interface AgentEdit {
  id: string;
  sessionId: string;
  turnId: string;
  /** What changed, in the agent's paths, e.g. `cards/Rumi Kang/Description`. */
  path: string;
  /** Where it lives, e.g. `field:<id>`, `main`, `block:<id>`, `message:<id>`, `file:<path>`. */
  target: string;
  /** The text before (null: it didn't exist) and after (null: deleted). */
  before: string | null;
  after: string | null;
  /** What's needed to put back something deleted or remove something created (JSON). */
  meta: Record<string, unknown> | null;
  createdAt: string;
  revertedAt: string | null;
}
