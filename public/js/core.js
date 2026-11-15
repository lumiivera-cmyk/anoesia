/**
 * What every module shares: the on-screen state, talking to the server,
 * turning text into safe HTML, and the small pieces (beads, macro chips,
 * token counts) every page draws. Imports nothing but icons.
 */

/** What the page is showing. The server is the source of truth. */
export const state = {
  settings: null,
  profiles: [],
  cards: [],
  chats: [],
  macros: [],
  apiKeySet: false,
  vertexReady: false,
  /** The open chat, its messages, and whether a reply is being written. */
  chatId: null,
  chat: null,
  messages: [],
  busy: false,
  /** The last error from writing a reply, shown above the composer with "try again". */
  replyError: null,
};

export const $ = (id) => document.getElementById(id);

/** Narrow screens get the phone layout (the boards switch at 900 px). */
export const isPhone = () => matchMedia("(max-width: 899px)").matches;
export const isTouch = () => matchMedia("(pointer: coarse)").matches;

/** Call the server's JSON API. Throws an Error with the server's message. */
export async function api(method, path, body) {
  // Relative, so the app works under a path (yourdomain/rp) as well as at the root.
  const response = await fetch(path.replace(/^\//, ""), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // not JSON: handled below
  }
  if (response.status === 401 && data?.login) {
    location.href = "login";
    throw new Error("Log in first.");
  }
  if (!response.ok) throw new Error(data?.error ?? `The server answered ${response.status}.`);
  return data;
}

/** Reload everything but the open chat's messages. */
export async function loadState() {
  const data = await api("GET", "/api/state");
  Object.assign(state, data);
}

export function cardById(id) {
  return state.cards.find((c) => c.id === id) ?? null;
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const SCENE_SHIFT = `<div class="scene-shift" role="separator" aria-label="Scene shift"><span class="rule"></span><span aria-hidden="true" class="dias"><span class="dia"></span><span class="dia"></span><span class="dia"></span></span><span class="rule"></span></div>`;

/**
 * Message text as safe HTML: escaped first, then paragraphs, light RP
 * formatting (`***bold italics***`, `**bold**`, `*italics*`), and a line
 * of `---` as the scene-shift mark.
 */
export function formatText(text) {
  return escapeHtml(text)
    .split(/\n[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\n|$)/)
    .map((part) => {
      const paras = part
        .trim()
        .split(/\n[ \t]*\n+/)
        .filter((p) => p.trim())
        .map(
          (p) =>
            `<p>${p
              .trim()
              .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
              .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
              .replace(/\*(.+?)\*/g, "<em>$1</em>")
              .replaceAll("\n", "<br>")}</p>`,
        )
        .join("");
      return paras ? `<div class="prose">${paras}</div>` : "";
    })
    .filter(Boolean)
    .join(SCENE_SHIFT);
}

/** About how many tokens a text is (four characters a token). */
export function approxTokens(text) {
  return Math.round(text.length / 4);
}

export const fmt = (n) => Number(n).toLocaleString("en-US");

/** A token chip: the count, or a dash for an empty field. */
export function tokChip(n, empty = false) {
  return empty ? `<span class="tok sunk" aria-label="empty">—</span>` : `<span class="tok sunk" aria-label="${fmt(n)} tokens">${fmt(n)}</span>`;
}

// ---------------------------------------------------------------- beads

export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  // "The Pale Vow" reads as P, not T.
  const first = words.length > 1 && /^the$/i.test(words[0]) ? words[1] : words[0];
  return first[0].toUpperCase();
}

/** A card's bead classes and inline colour: a preset class, or `.gem-custom` with `--gem`. */
export function gemOf(colour) {
  if (typeof colour === "string" && colour.startsWith("#")) return { cls: "gem gem-custom", style: `--gem: ${colour};` };
  return { cls: `gem gem-${["violet", "blue", "pink"].includes(colour) ? colour : "violet"}`, style: "" };
}

/** A bead for a card, `size` px across, with its initial unless `label` is false. */
export function gem(card, size = 26, { label = true, extraClass = "", style = "" } = {}) {
  const g = gemOf(card?.colour);
  const fs = size >= 56 ? "26px" : size >= 26 ? "var(--fs-xs)" : "var(--fs-2xs)";
  const text = label && size >= 18 ? `<span class="gem-i">${escapeHtml(initials(card?.name ?? "?"))}</span>` : "";
  return `<span class="${g.cls}${card?.isPersona ? " is-persona" : ""} ${extraClass}" aria-hidden="true" style="${g.style}width:${size}px;height:${size}px;font-size:${fs};${style}">${text}</span>`;
}

// --------------------------------------------------------------- macros

const MACRO = /\{\{([\s\S]*?)\}\}/g;

/** The macro's name: `name::a`, `name:a` or `name a` → name. */
export function macroName(inner) {
  const t = inner.trim();
  if (t.startsWith("//")) return "//";
  return t.split(/::|:|\s/)[0].toLowerCase();
}

export function isKnownMacro(inner) {
  return state.macros.includes(macroName(inner));
}

/** Text with each `{{macro}}` as a chip, and unknown ones flagged. Returns html and the unknown names. */
export function macroHtml(text) {
  const unknown = [];
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MACRO)) {
    out += escapeHtml(text.slice(last, m.index));
    const known = isKnownMacro(m[1]);
    if (!known) unknown.push(m[1].trim());
    out += `<span class="mac${known ? "" : " bad"}"${known ? "" : ' title="Unknown macro"'}>${escapeHtml(m[1].trim())}</span>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return { html: out, unknown: [...new Set(unknown)] };
}

// ---------------------------------------------------------------- toasts

/** Say what went wrong, in a toast at the bottom of the screen (null hides it). */
export function showError(message) {
  const toast = $("toast");
  toast.querySelector("[data-text]").textContent = message ?? "";
  toast.hidden = !message;
}

/** Run an async action and show what went wrong, if anything. */
export async function attempt(action) {
  try {
    return await action();
  } catch (error) {
    showError(error.message);
    return undefined;
  }
}

export function timeLabel(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return today ? t : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase()}, ${t}`;
}

export function dayLabel(iso) {
  const d = new Date(iso);
  if (new Date().toDateString() === d.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
}

/** "deepseek-ai/DeepSeek-V3.1" → "DeepSeek-V3.1". */
export function shortModel(model) {
  return String(model).split("/").at(-1) ?? "";
}

/** "Rumi, Mira and Zoey". */
/** How a card is named in a short list: a character by first name, anything else in full. */
export function shortName(card) {
  if (!card.isCharacter) return card.name.trim();
  const words = card.name.trim().split(/\s+/);
  return words.length > 1 && /^the$/i.test(words[0]) ? words.slice(0, 2).join(" ") : words[0];
}

export function listNames(names) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The persona in a chat's cast, if any. */
export function personaOf(chat) {
  return (chat?.cast ?? []).map(cardById).find((c) => c?.isPersona) ?? null;
}

/** Go to a page of the app (hash routes: #/chat/id, #/prompts, #/cards/id). */
export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}
