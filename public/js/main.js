/**
 * Where the app starts: load everything, draw the sidebar, and follow the
 * hash route to the chat, the prompts page, the cards page or settings.
 */

import { $, attempt, go, loadState, showError, state } from "./core.js";
import { icon } from "./icons.js";
import { openDrawer, renderSide, wireSide } from "./side.js";
import { applyBackground, applyMaterial } from "./theme.js";
import { openChat, showChatView, wireChat } from "./chat.js";
import { showPrompts, wirePrompts } from "./prompts.js";
import { showCards, wireCards } from "./cards.js";
import { showSettings, wireSettings } from "./settings.js";
import { wireTextEditor } from "./editor.js";
import { wireAgent } from "./agent.js";

// ------------------------------------------------------------------ router

async function route() {
  const [, page = "chat", id = "", sub = ""] = location.hash.split("/");
  if (page === "chat" || page === "") {
    if (id && id !== state.chatId) await openChat(id);
    showView("chat");
    showChatView();
  } else if (page === "prompts") {
    if (!state.chatId) return go("#/");
    showView("prompts");
    await showPrompts(id === "preview" ? "preview" : "blocks");
  } else if (page === "cards") {
    showView("cards");
    showCards(id || null);
  } else if (page === "settings") {
    showView("settings");
    await showSettings(id, sub);
  } else go("#/");
  renderSide();
}

function showView(name) {
  for (const v of ["chat", "prompts", "cards", "settings"]) $(`view-${v}`).hidden = v !== name;
  document.documentElement.dataset.view = name;
  applyMaterial();
  if (name !== "chat") $(`view-${name}`).querySelector("h1")?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------- start

async function start() {
  wireSide($("side"));
  wireSide($("drawer"));
  $("open-drawer").innerHTML = icon.menu();
  $("open-drawer").addEventListener("click", (e) => openDrawer(e.currentTarget));
  $("toast-close").innerHTML = icon.close(18);
  $("toast-close").addEventListener("click", () => showError(null));
  wireChat();
  wirePrompts();
  wireCards();
  wireSettings();
  wireTextEditor();
  wireAgent();
  $("confirm-icon").innerHTML = icon.trash(16);
  for (const h of document.querySelectorAll("h1")) h.tabIndex = -1;
  try {
    await loadState();
  } catch (error) {
    showError(`Couldn't reach the server: ${error.message}`);
    return;
  }
  applyBackground(state.settings.background);
  // A wide window and a phone show different layouts: redraw on the switch.
  matchMedia("(max-width: 899px)").addEventListener("change", () => route());
  let last = "";
  try {
    last = localStorage.getItem("anoesia.chat") ?? "";
  } catch {
    // private mode
  }
  const first = state.chats.find((c) => c.id === last) ?? state.chats[0];
  if (first) await attempt(() => openChat(first.id));
  window.addEventListener("hashchange", route);
  await route();
}

start();
