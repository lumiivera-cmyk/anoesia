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
}
