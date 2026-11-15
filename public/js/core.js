/**
 * What every module shares: the on-screen state, talking to the server,
 * and turning text into safe HTML. Imports nothing.
 */

/** What the page is showing. The server is the source of truth. */
export const state = {
  settings: null,
  profiles: [],
  cards: [],
  chats: [],
  apiKeySet: false,
  vertexReady: false,
  /** The open chat, its messages, and whether a reply is being written. */
  chatId: null,
  chat: null,
  messages: [],
  busy: false,
};

export const $ = (id) => document.getElementById(id);

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

/**
 * Message text as safe HTML: escaped first, then light RP formatting
 * (`***bold italics***`, `**bold**`, `*italics*`), and a line of `---` as a
 * scene divider. Line breaks are kept by CSS.
 */
export function formatText(text) {
  return escapeHtml(text)
    .split(/\n[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\n|$)/)
    .map((part) =>
      part
        .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .trim(),
    )
    .join('<hr class="scene-break" />');
}

/** About how many tokens a text is (four characters a token). */
export function approxTokens(text) {
  return Math.round(text.length / 4);
}

/** Show an error in the bar above the composer (null hides it). */
export function showError(message) {
  const bar = $("error-bar");
  bar.textContent = message ?? "";
  bar.hidden = !message;
}

/** Run an async action and show what went wrong, if anything. */
export async function attempt(action) {
  try {
    showError(null);
    return await action();
  } catch (error) {
    showError(error.message);
    return undefined;
  }
}

/** Open a <dialog>, wiring its close buttons once. */
export function openDialog(id) {
  const dialog = $(id);
  if (!dialog.dataset.wired) {
    dialog.dataset.wired = "1";
    for (const b of dialog.querySelectorAll("[data-close]")) b.addEventListener("click", () => dialog.close());
  }
  if (!dialog.open) dialog.showModal();
  return dialog;
}

export function timeLabel(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
