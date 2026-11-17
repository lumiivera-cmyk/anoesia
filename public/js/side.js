/**
 * The sidebar on a wide screen, and the same things in a drawer on a phone:
 * new chat, the chat list, and links to Cards, Prompts and Settings (a page
 * of its own, #/settings).
 */

import { $, cardById, dayLabel, escapeHtml, shortName, state } from "./core.js";
import { icon } from "./icons.js";
import { closeOverlay, openOverlay } from "./overlay.js";
import { newChat } from "./chat.js";

/** The sidebar (wide) and the drawer (phone) hold the same things. */
export function renderSide() {
  const page = location.hash.split("/")[1] || "chat";
  const rows = state.chats
    .map((c) => {
      const names = c.cast.map(cardById).filter((x) => x && !x.isPersona).map(shortName);
      const cast = names.join(" · ");
      const current = c.id === state.chatId;
      return `<li><a class="chat-row press ${current ? "raised is-on" : "row"}" href="#/chat/${c.id}" ${current ? 'aria-current="page"' : ""}>
        <span class="cr-name">${escapeHtml(c.name)}</span><span class="meta cr-meta">${cast ? `<span class="cr-cast">${escapeHtml(cast)}</span><span aria-hidden="true">·</span>` : ""}<span class="cr-when">${escapeHtml(dayLabel(c.updatedAt))}</span></span></a></li>`;
    })
    .join("");
  const nav = (key, label, href, glyph, extra = "") => {
    const here = page === key;
    return `<a class="${here ? "raised" : "ghost"} press appnav-item" href="${href}" ${here ? 'aria-current="page"' : ""} ${extra}>${glyph}<span>${label}</span></a>`;
  };
  const html = `
    <div class="brand"><span class="disp wordmark">Anoesia</span>
      <span class="brand-gems" aria-hidden="true"><span class="gem gem-violet"></span><span class="gem gem-blue"></span><span class="gem gem-pink"></span></span>
      <button type="button" class="ghost press ib phone-only" data-close-drawer aria-label="Close chats">${icon.close()}</button>
    </div>
    <button type="button" class="raised press new-chat" data-new-chat>${icon.plus()} new chat</button>
    <nav class="chats scroll" aria-label="Chats">
      <span class="eyebrow">Chats</span>
      ${rows ? `<ul class="chat-rows">${rows}</ul>` : `<p class="meta empty-note">No chats yet. Start one with new chat.</p>`}
    </nav>
    <nav class="sunk appnav" aria-label="App">
      ${nav("cards", "Cards", state.chatId && page === "cards" ? "#/cards" : "#/cards", icon.cards())}
      ${nav("prompts", "Prompts", "#/prompts", icon.prompts())}
      ${nav("settings", "Settings", "#/settings", icon.settings())}
    </nav>`;
  $("side").innerHTML = html;
  $("drawer").innerHTML = `<div class="drawer-in">${html}</div>`;
  for (const a of $("side").querySelectorAll('a[href="#/prompts"]')) if (!state.chatId) a.setAttribute("aria-disabled", "true");
}

export function wireSide(root) {
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-new-chat]")) {
      closeOverlay($("drawer"));
      newChat();
    } else if (e.target.closest("[data-close-drawer]")) closeOverlay($("drawer"));
    else if (e.target.closest("a")) {
      if (e.target.closest('a[aria-disabled="true"]')) e.preventDefault();
      closeOverlay($("drawer"));
    }
  });
}

export function openDrawer(opener) {
  openOverlay($("drawer"), { opener, focus: "[aria-current=page], [data-new-chat]" });
}

