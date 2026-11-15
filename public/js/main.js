/**
 * Where the app starts: load everything, wire the buttons, open the last chat.
 */

import { loadState, showError, state } from "./core.js";
import { openChat, renderChatList, wireChat } from "./chat.js";
import { wireCards } from "./cards.js";
import { wireSettings } from "./settings.js";
import { wirePrompts } from "./prompts.js";

async function start() {
  wireChat();
  wireCards();
  wireSettings();
  wirePrompts();
  try {
    await loadState();
  } catch (error) {
    showError(`Couldn't reach the server: ${error.message}`);
    return;
  }
  let last = "";
  try {
    last = localStorage.getItem("anoesia.chat") ?? "";
  } catch {
    // private mode
  }
  const open = state.chats.find((c) => c.id === last) ?? state.chats[0];
  renderChatList();
  await openChat(open?.id ?? null);
}

start();
