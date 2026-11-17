/**
 * The open chat: its header and cast, the messages, the composer, message
 * actions, and chat settings (name, cast, delete).
 */

import {
  $,
  api,
  attempt,
  cardById,
  escapeHtml,
  formatText,
  gem,
  go,
  isPhone,
  isTouch,
  loadState,
  personaOf,
  enterHint,
  sendsOnEnter,
  shortModel,
  shortName,
  showError,
  state,
  timeLabel,
} from "./core.js";
import { icon } from "./icons.js";
import { closeOverlay, confirmDialog, openOverlay } from "./overlay.js";
import { renderSide } from "./side.js";

// ------------------------------------------------------------------ opening

export async function openChat(id) {
  state.chatId = id;
  state.replyError = null;
  try {
    localStorage.setItem("anoesia.chat", id ?? "");
  } catch {
    // private mode: fine
  }
  if (!id) {
    state.chat = null;
    state.messages = [];
    document.dispatchEvent(new CustomEvent("anoesia:chat-opened"));
    return;
  }
  const view = await attempt(() => api("GET", `/api/chats/${id}`));
  if (view) applyView(view, false);
  else {
    state.chatId = null;
    state.chat = null;
    state.messages = [];
  }
  // The open chat's own agent follows the chat (js/agent.js).
  document.dispatchEvent(new CustomEvent("anoesia:chat-opened"));
}

function applyView(view, draw = true) {
  state.chat = view.chat;
  state.messages = view.messages;
  state.busy = view.busy;
  if (view.error) state.replyError = view.error;
  const i = state.chats.findIndex((c) => c.id === view.chat.id);
  if (i >= 0) state.chats[i] = view.chat;
  if (draw) renderChat();
}

/** Show the chat page (called by the router). */
export function showChatView() {
  $("enter-hint").textContent = enterHint();
  renderChat(true);
}

export async function newChat() {
  // A new chat starts with the cast of the chat you're in, if any.
  const cast = state.chat?.cast ?? [];
  const chat = await attempt(() => api("POST", "/api/chats", { name: "New chat", cast }));
  if (!chat) return;
  await loadState();
  await openChat(chat.id);
  go(`#/chat/${chat.id}`);
  openChatSettings();
}

// ------------------------------------------------------------------- header

export function renderChat(scrollToEnd = false) {
  const chat = state.chat;
  const persona = personaOf(chat);
  const cast = (chat?.cast ?? []).map(cardById).filter(Boolean);
  const count = state.messages.length;
  $("chat-name").textContent = chat ? chat.name : "Anoesia";
  $("chat-meta").textContent = chat ? `narrator · ${count} message${count === 1 ? "" : "s"}` : "";
  $("cast-chips").innerHTML = cast
    .map((c) =>
      c.isPersona
        ? `<li><a class="sunk press chip" href="#/cards/${c.id}">${gem(c, 26)}${escapeHtml(c.name)} <span class="chip-you">· you</span></a></li>`
        : `<li><a class="raised press chip" href="#/cards/${c.id}">${gem(c, 26)}${escapeHtml(c.name)}</a></li>`,
    )
    .join("");
  const others = cast.filter((c) => !c.isPersona);
  $("phone-title").innerHTML = `<span class="pt-name">${escapeHtml(chat ? chat.name : "Anoesia")}</span>
    <span class="pt-line">${others.length ? `<span class="pt-gems">${others.map((c) => gem(c, 12, { label: false })).join("")}</span>` : ""}<span class="meta">${escapeHtml(chat ? `${others.map(shortName).join(", ") || "no cast yet"}` : "")}</span></span>`;
  $("phone-title").setAttribute("aria-label", `${chat ? `${chat.name} ${others.map(shortName).join(", ") || "no cast yet"}` : "Anoesia"}: chat settings`);
  for (const id of ["go-preview", "go-prompts", "open-chat-settings", "open-chat-menu", "phone-title"]) {
    const el = $(id);
    if (chat) el.removeAttribute("aria-disabled");
    else el.setAttribute("aria-disabled", "true");
  }
  const who = persona ? `Write as ${persona.name}` : "Write your turn";
  $("composer-label").textContent = who;
  $("composer-input").placeholder = `${who}…`;
  $("composer-input").disabled = !chat;
  $("send").hidden = state.busy;
  $("stop").hidden = !state.busy;
  $("send").disabled = !chat;
  $("continue").disabled = !chat || state.busy;
  $("reply-error").hidden = !state.replyError;
  $("reply-error").querySelector("[data-text]").textContent = state.replyError ?? "";
  renderMessages(scrollToEnd);
}

// ----------------------------------------------------------------- messages

function renderMessages(scrollToEnd) {
  const box = $("messages");
  const scroller = $("messages-scroll");
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  if (!state.chat) {
    box.innerHTML = state.chats.length
      ? `<div class="empty raised"><p class="disp">Pick a chat</p><p class="meta">Your chats are in the list${isPhone() ? " under the menu button" : " on the left"}.</p></div>`
      : `<div class="empty raised"><p class="disp">No chats yet</p><p class="meta">Start one, then add your cards to its cast.</p><button type="button" class="btn btn-primary press" data-empty-new>${icon.plus(16)} new chat</button></div>`;
    return;
  }
  const lastReply = state.messages.at(-1)?.role === "assistant" ? state.messages.at(-1) : null;
  let html = state.messages.map((m) => messageHtml(m, m === lastReply)).join("");
  if (state.busy) html += `<div class="writing" role="status"><span class="eyebrow">Narrator</span><span class="meta">writing<span class="caret" aria-hidden="true">▍</span></span></div>`;
  if (!html) {
    const castEmpty = !state.chat.cast.length;
    html = `<div class="empty raised"><p class="disp">Nothing here yet</p><p class="meta">${
      castEmpty ? "Add your cards to this chat's cast first, then write the opening." : "Write the opening, or press continue to let the narrator begin."
    }</p>${castEmpty ? `<button type="button" class="btn raised press" data-empty-cast>${icon.sliders(18)} chat settings</button>` : ""}</div>`;
  }
  box.innerHTML = html;
  if (scrollToEnd || atEnd) scroller.scrollTop = scroller.scrollHeight;
}

function versionsHtml(m) {
  if (m.swipes.length < 2) return "";
  return `<span class="sunk versions">
    <button type="button" class="ghost press ib" data-act="prev" aria-label="Previous version" ${m.swipeIndex === 0 ? 'aria-disabled="true"' : ""}>${icon.left()}</button>
    <span class="vcount">${m.swipeIndex + 1} / ${m.swipes.length}</span>
    <button type="button" class="ghost press ib" data-act="next" aria-label="Next version" ${m.swipeIndex === m.swipes.length - 1 ? 'aria-disabled="true"' : ""}>${icon.right()}</button>
  </span>`;
}

function messageHtml(m, isLastReply) {
  const you = m.role === "user";
  const persona = personaOf(state.chat);
  const meta = [timeLabel(m.createdAt), m.editedAt ? "edited" : "", !you && m.model ? shortModel(m.model) : ""].filter(Boolean).join(" · ");
  const versions = versionsHtml(m);
  const regen = isLastReply ? `<button type="button" class="raised press ib act-regen" data-act="regen" aria-label="Regenerate" title="Regenerate">${icon.regen()}</button>` : "";
  const acts = `<span class="acts">
      <button type="button" class="ghost press ib act" data-act="copy" aria-label="Copy" title="Copy">${icon.copy()}</button>
      <button type="button" class="ghost press ib act" data-act="edit" aria-label="Edit" title="Edit">${icon.edit()}</button>
      <button type="button" class="ghost press ib act" data-act="delete" aria-label="Delete" title="Delete">${icon.trash()}</button>
      ${versions}${regen}
    </span>`;
  const label = you
    ? `Your message${persona ? `, as ${persona.name}` : ""}`
    : `Narrator reply${m.swipes.length > 1 ? `, version ${m.swipeIndex + 1} of ${m.swipes.length}` : ""}`;
  const head = you
    ? `<div class="mhead">${persona ? gem(persona, 22) : ""}<span class="you-name">${escapeHtml(persona?.name ?? "You")}</span><span class="meta">${escapeHtml(meta)}</span>${acts}</div>`
    : `<div class="mhead"><span class="eyebrow">Narrator</span><span class="meta">${escapeHtml(meta)}</span>${acts}</div>`;
  // On a phone the last reply keeps its versions and regenerate under it; a tap on any message opens the rest.
  const phoneRow = !you && (isLastReply || versions) ? `<div class="phone-row">${versions}${regen}${isLastReply ? `<span class="meta">tap a message for more</span>` : ""}</div>` : "";
  return `<article class="msg ${you ? "you sunk" : "narrator"}" data-id="${m.id}" aria-label="${escapeHtml(label)}">
    ${head}
    <div class="msg-body">${formatText(m.content)}</div>
    ${phoneRow}
  </article>`;
}

async function onMessageClick(event) {
  if (event.target.closest("[data-empty-new]")) return newChat();
  if (event.target.closest("[data-empty-cast]")) return openChatSettings(event.target.closest("button"));
  const article = event.target.closest(".msg");
  if (!article || article.classList.contains("editing")) return;
  const m = state.messages.find((x) => x.id === article.dataset.id);
  if (!m) return;
  const button = event.target.closest("[data-act]");
  if (!button) {
    // A tap on a phone opens the message's actions.
    if (isPhone() || isTouch()) openMessageMenu(m, article);
    return;
  }
  if (button.getAttribute("aria-disabled") === "true") return;
  await act(button.dataset.act, m, article, button);
}

async function act(what, m, article, opener) {
  if (what === "copy") {
    const ok = await navigator.clipboard?.writeText(m.content).then(() => true, () => false);
    if (!ok) return showError("Couldn't copy. Your browser blocked the clipboard.");
    // A tick for a moment, so the copy is seen (the phone's menu has closed by now).
    if (opener?.dataset.act === "copy") {
      opener.innerHTML = icon.check();
      opener.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        opener.innerHTML = icon.copy();
        opener.setAttribute("aria-label", "Copy");
      }, 1400);
    }
    return;
  }
  if (what === "edit") return startEdit(article, m);
  if (what === "delete") {
    const ok = await confirmDialog({ title: "Delete this message?", body: m.swipes.length > 1 ? `It goes for good, with all ${m.swipes.length} of its versions.` : "It goes for good.", confirm: "delete", keep: "keep it", opener });
    if (!ok) return;
    await attempt(() => api("DELETE", `/api/messages/${m.id}`));
    return refresh();
  }
  if (what === "prev" || what === "next") {
    const view = await attempt(() => api("PATCH", `/api/messages/${m.id}`, { swipeIndex: m.swipeIndex + (what === "next" ? 1 : -1) }));
    if (view) await refresh();
    return;
  }
  if (what === "regen") return run(() => api("POST", `/api/chats/${state.chatId}/regenerate`));
}

function openMessageMenu(m, article) {
  const isLastReply = m === state.messages.at(-1) && m.role === "assistant";
  $("lifted").innerHTML = article.querySelector(".mhead").outerHTML + article.querySelector(".msg-body").innerHTML;
  for (const a of $("lifted").querySelectorAll(".acts")) a.remove();
  const items = [
    ["copy", icon.copy(20), "Copy"],
    ["edit", icon.edit(20), "Edit"],
    ...(isLastReply ? [["regen", icon.regen(20), "Regenerate"]] : []),
    ["delete", icon.trash(20), "Delete"],
  ];
  $("message-menu-items").innerHTML = items
    .map(([k, ic, label]) => `${k === "delete" ? '<span class="menu-rule" aria-hidden="true"></span>' : ""}<button type="button" role="menuitem" class="press${k === "delete" ? " danger" : ""}" data-menu-act="${k}"><span class="mi">${ic}</span>${label}</button>`)
    .join("");
  const dialog = $("message-menu");
  dialog.onclick = (e) => {
    const b = e.target.closest("[data-menu-act]");
    if (!b) return;
    closeOverlay(dialog);
    const fresh = $("messages").querySelector(`[data-id="${m.id}"]`);
    act(b.dataset.menuAct, m, fresh, fresh);
  };
  openOverlay(dialog, { opener: article, focus: "[role=menuitem]" });
}

function startEdit(article, m) {
  article.classList.add("editing");
  const body = article.querySelector(".msg-body");
  body.innerHTML = `<form class="msg-edit"><label class="sr" for="edit-${m.id}">Edit message</label>
    <textarea id="edit-${m.id}" class="sunk">${escapeHtml(m.content)}</textarea>
    <div class="edit-buttons"><button type="button" class="btn ghost press" data-cancel>cancel</button><button type="submit" class="btn btn-primary press">save</button></div></form>`;
  const form = body.querySelector("form");
  const area = form.querySelector("textarea");
  const fit = () => {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight + 4}px`;
  };
  area.addEventListener("input", fit);
  fit();
  area.focus();
  form.querySelector("[data-cancel]").addEventListener("click", () => renderMessages(false));
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape") renderMessages(false);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await attempt(() => api("PATCH", `/api/messages/${m.id}`, { content: area.value }))) refresh();
  });
}

async function refresh() {
  if (!state.chatId) return;
  await attempt(async () => applyView(await api("GET", `/api/chats/${state.chatId}`)));
}

/** Run a request that writes a reply, showing "writing" while it does. */
async function run(request) {
  state.busy = true;
  state.replyError = null;
  renderChat(true);
  const view = await attempt(request);
  state.busy = false;
  if (view) applyView(view);
  else await refresh();
  if (view && !view.error) state.replyError = null;
  renderChat();
  await loadState();
  renderSide();
}

// ------------------------------------------------------------------ composer

async function send(event) {
  event?.preventDefault();
  if (!state.chatId || state.busy) return;
  const input = $("composer-input");
  const content = input.value;
  input.value = "";
  autosize();
  // Show your message straight away, before the reply comes back.
  if (content.trim()) state.messages.push({ id: "pending", role: "user", content, swipes: [content], swipeIndex: 0, createdAt: new Date().toISOString(), editedAt: null, model: "" });
  await run(() => api("POST", `/api/chats/${state.chatId}/send`, { content }));
}

function autosize() {
  const input = $("composer-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight + 2, Math.round(innerHeight * 0.4))}px`;
}

// ------------------------------------------------------------- chat settings

export function openChatSettings(opener = document.activeElement) {
  if (!state.chat) return;
  renderChatSettings();
  openOverlay($("chat-dialog"), { opener, focus: "#chat-name-input" });
}

function kindOf(card) {
  return card.isPersona ? "your persona" : card.isCharacter ? "character" : "world, not in cast";
}

function renderChatSettings() {
  const chat = state.chat;
  const cast = chat.cast.map(cardById).filter(Boolean);
  const free = state.cards.filter((c) => !chat.cast.includes(c.id));
  $("chat-dialog").innerHTML = `
    <header class="dlg-head"><h2 class="disp" id="chat-dialog-title">Chat settings</h2>
      <button type="button" class="ghost press ib" data-close aria-label="Close">${icon.close()}</button></header>
    <div class="dlg-body scroll">
      <label class="field-label" for="chat-name-input">name</label>
      <div class="sunk well"><input id="chat-name-input" class="inp" value="${escapeHtml(chat.name)}" maxlength="200" autocomplete="off" /></div>
      <h3 class="eyebrow">cast</h3>
      <p class="meta small">The cards in this chat. Each one's fields arrive as a folder on the prompts page, where you set their order.</p>
      <ul class="cast-list">${
        cast
          .map(
            (c) => `<li class="raised cast-row">${gem(c, 30)}<span class="cr-text"><span class="cr-n">${escapeHtml(c.name)}</span><span class="meta">${kindOf(c)}</span></span>
            <a class="ghost press ib" href="#/cards/${c.id}" aria-label="Open ${escapeHtml(c.name)}'s card">${icon.edit()}</a>
            <button type="button" class="ghost press ib" data-remove="${c.id}" aria-label="Take ${escapeHtml(c.name)} out of the cast">${icon.close(18)}</button></li>`,
          )
          .join("") || `<li class="meta">No cards in this chat yet.</li>`
      }</ul>
      <div class="add-cast">
        <label class="sr" for="cast-add">Add a card to the cast</label>
        <div class="sunk well select-well"><select id="cast-add" class="inp">${
          free.length
            ? `<option value="">add a card…</option>${free.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.isPersona ? " (you)" : ""}</option>`).join("")}`
            : `<option value="">${state.cards.length ? "every card is in the cast" : "no cards yet: import some on the cards page"}</option>`
        }</select></div>
        <button type="button" class="btn raised press" id="cast-add-go" disabled>${icon.plus(16)} add</button>
      </div>
    </div>
    <footer class="dlg-foot">
      <button type="button" class="btn btn-quiet-danger press" id="delete-chat">${icon.trash()} delete this chat</button>
      <button type="button" class="btn btn-primary press" data-close>done</button>
    </footer>`;
}

async function saveCast(cast) {
  const chat = await attempt(() => api("PATCH", `/api/chats/${state.chatId}`, { cast }));
  if (!chat) return;
  state.chat = chat;
  renderChatSettings();
  renderChat();
}

function wireChatDialog() {
  const d = $("chat-dialog");
  // add waits for a card to be picked
  d.addEventListener("change", (e) => {
    if (e.target.id === "cast-add") $("cast-add-go").disabled = !e.target.value;
  });
  d.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close]")) return closeOverlay(d);
    const remove = e.target.closest("[data-remove]");
    if (remove) return saveCast(state.chat.cast.filter((id) => id !== remove.dataset.remove));
    if (e.target.closest("#cast-add-go")) {
      const id = $("cast-add").value;
      if (id) saveCast([...state.chat.cast, id]);
      return;
    }
    if (e.target.closest("a[href]")) return closeOverlay(d, "replace");
    if (e.target.closest("#delete-chat")) {
      const chat = state.chat;
      const ok = await confirmDialog({
        title: `Delete ${chat.name}?`,
        body: [`Its ${state.messages.length} message${state.messages.length === 1 ? "" : "s"} and its prompt go with it. The cards stay.`],
        confirm: "delete chat",
        keep: "keep it",
        opener: e.target.closest("button"),
      });
      if (!ok) return;
      if (!(await attempt(() => api("DELETE", `/api/chats/${chat.id}`)))) return;
      closeOverlay(d, "replace");
      await loadState();
      await openChat(state.chats[0]?.id ?? null);
      go(state.chatId ? `#/chat/${state.chatId}` : "#/");
    }
  });
  d.addEventListener("change", async (e) => {
    if (e.target.id !== "chat-name-input" || !e.target.value.trim()) return;
    const chat = await attempt(() => api("PATCH", `/api/chats/${state.chatId}`, { name: e.target.value }));
    if (!chat) return;
    state.chat = chat;
    await loadState();
    renderChat();
    renderSide();
  });
}

// --------------------------------------------------------------------- wire

export function wireChat() {
  $("send").innerHTML = icon.send();
  $("stop").innerHTML = icon.stop();
  $("continue").insertAdjacentHTML("beforeend", icon.go());
  $("open-chat-settings").innerHTML = icon.sliders();
  $("go-preview").innerHTML = icon.eye();
  $("go-prompts").innerHTML = icon.prompts(20, false);
  $("open-chat-menu").innerHTML = icon.more();
  $("dismiss-error").innerHTML = icon.close(18);
  $("cm-eye").innerHTML = icon.eye();
  $("cm-prompts").innerHTML = icon.prompts(20, false);
  $("cm-settings").innerHTML = icon.sliders();

  $("messages").addEventListener("click", onMessageClick);
  $("composer").addEventListener("submit", send);
  $("continue").addEventListener("click", () => {
    if (!state.busy && state.chatId) run(() => api("POST", `/api/chats/${state.chatId}/send`, { content: "" }));
  });
  $("retry").addEventListener("click", () => {
    if (state.busy || !state.chatId) return;
    // A failed reply kept your message, so trying again lets the narrator answer it.
    const last = state.messages.at(-1);
    if (last?.role === "assistant") run(() => api("POST", `/api/chats/${state.chatId}/regenerate`));
    else run(() => api("POST", `/api/chats/${state.chatId}/send`, { content: "" }));
  });
  $("dismiss-error").addEventListener("click", () => {
    state.replyError = null;
    $("reply-error").hidden = true;
  });
  $("composer-input").addEventListener("input", autosize);
  $("composer-input").addEventListener("keydown", (e) => {
    // Enter sends on a computer (Settings → Typing can make it Ctrl+Enter); on a phone it's a new line and only Send sends.
    if (sendsOnEnter(e)) {
      e.preventDefault();
      send();
    }
  });
  $("stop").addEventListener("click", () => api("POST", `/api/chats/${state.chatId}/stop`).catch(() => {}));
  const guard = (fn) => (e) => {
    if (e.currentTarget.getAttribute("aria-disabled") === "true") {
      e.preventDefault();
      return;
    }
    fn(e);
  };
  $("open-chat-settings").addEventListener("click", guard((e) => openChatSettings(e.currentTarget)));
  $("phone-title").addEventListener("click", guard((e) => openChatSettings(e.currentTarget)));
  $("go-preview").addEventListener("click", guard(() => {}));
  $("go-prompts").addEventListener("click", guard(() => {}));
  $("open-chat-menu").addEventListener("click", guard((e) => openOverlay($("chat-menu"), { opener: e.currentTarget, anchor: e.currentTarget, focus: "[role=menuitem]" })));
  $("chat-menu").addEventListener("click", (e) => {
    const b = e.target.closest("[role=menuitem]");
    if (!b) return;
    const opener = $("open-chat-menu");
    closeOverlay($("chat-menu"), "replace");
    if (b.dataset.go) go(b.dataset.go);
    else openChatSettings(opener);
  });
  wireChatDialog();
  void showError;
}
