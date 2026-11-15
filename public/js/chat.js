/**
 * The chat list, the open chat's messages, and the composer.
 */

import { $, api, attempt, cardById, escapeHtml, formatText, loadState, openDialog, showError, state, timeLabel } from "./core.js";

// ------------------------------------------------------------ chat list

export function renderChatList() {
  const list = $("chat-list");
  if (state.chats.length === 0) {
    list.innerHTML = `<p class="muted small" style="padding: 0 0.65em">No chats yet.</p>`;
    return;
  }
  list.innerHTML = state.chats
    .map((c) => `<button type="button" class="chat-link${c.id === state.chatId ? " active" : ""}" data-chat="${c.id}">${escapeHtml(c.name)}</button>`)
    .join("");
}

export async function openChat(id) {
  state.chatId = id;
  try {
    localStorage.setItem("anoesia.chat", id ?? "");
  } catch {
    // private mode: fine
  }
  if (!id) {
    state.chat = null;
    state.messages = [];
    renderChat();
    renderChatList();
    return;
  }
  await attempt(async () => {
    const view = await api("GET", `/api/chats/${id}`);
    applyView(view);
  });
  renderChatList();
  closeSidebar();
}

function applyView(view) {
  state.chat = view.chat;
  state.messages = view.messages;
  state.busy = view.busy;
  const i = state.chats.findIndex((c) => c.id === view.chat.id);
  if (i >= 0) state.chats[i] = view.chat;
  renderChat();
  if (view.error) showError(view.error);
}

export async function newChat() {
  // A new chat starts with the cast of the chat you're in, if any.
  const cast = state.chat?.cast ?? [];
  const chat = await attempt(() => api("POST", "/api/chats", { name: "New chat", cast }));
  if (!chat) return;
  await loadState();
  await openChat(chat.id);
  openChatSettings();
}

// ----------------------------------------------------------------- chat

export function renderChat() {
  const chat = state.chat;
  $("chat-name").textContent = chat ? chat.name : "No chat open";
  const names = (chat?.cast ?? []).map((id) => cardById(id)).filter(Boolean).map((c) => (c.isPersona ? `${c.name} (you)` : c.name));
  $("cast-line").textContent = chat ? (names.length ? names.join(" · ") : "No cast yet: add cards in chat settings") : "";
  $("open-preview").disabled = !chat;
  $("open-prompts").disabled = !chat;
  $("open-chat-settings").disabled = !chat;
  $("send").disabled = !chat || state.busy;
  $("stop").hidden = !state.busy;
  renderMessages();
}

function personaName() {
  const persona = (state.chat?.cast ?? []).map((id) => cardById(id)).find((c) => c?.isPersona);
  return persona?.name ?? "You";
}

function renderMessages() {
  const box = $("messages");
  if (!state.chat) {
    box.innerHTML = `<p class="empty">${state.chats.length ? "Pick a chat." : "Start a chat with ＋, then add your cards to its cast."}</p>`;
    return;
  }
  const last = state.messages.at(-1);
  const html = state.messages.map((m) => messageHtml(m, m === last)).join("");
  const writing = state.busy ? `<div class="writing">The narrator is writing…</div>` : "";
  box.innerHTML = html || writing ? html + writing : `<p class="empty">Nothing yet. Write the opening, or press Send with an empty box to let the narrator begin.</p>`;
  box.scrollTop = box.scrollHeight;
}

function messageHtml(m, isLast) {
  const user = m.role === "user";
  const author = user ? personaName() : "Narrator";
  const meta = [timeLabel(m.createdAt), m.editedAt ? "edited" : "", !user && m.model ? m.model : ""].filter(Boolean).join(" · ");
  const swipes =
    m.swipes.length > 1
      ? `<button type="button" class="icon-button" data-act="prev" title="Previous version" ${m.swipeIndex === 0 ? "disabled" : ""}>‹</button>
         <span class="swipe-count">${m.swipeIndex + 1} / ${m.swipes.length}</span>
         <button type="button" class="icon-button" data-act="next" title="Next version" ${m.swipeIndex === m.swipes.length - 1 ? "disabled" : ""}>›</button>`
      : "";
  const regen = !user && isLast ? `<button type="button" class="icon-button" data-act="regen" title="Regenerate">↻</button>` : "";
  return `<article class="message ${user ? "user" : "narrator"}" data-id="${m.id}">
    <div class="message-head"><span class="message-author">${escapeHtml(author)}</span><span class="message-meta">${escapeHtml(meta)}</span></div>
    <div class="message-body">${formatText(m.content)}</div>
    <div class="message-actions">
      ${swipes}${regen}
      <button type="button" class="icon-button" data-act="edit" title="Edit">✎</button>
      <button type="button" class="icon-button" data-act="copy" title="Copy">⧉</button>
      <button type="button" class="icon-button" data-act="delete" title="Delete">🗑</button>
    </div>
  </article>`;
}

async function onMessageAction(event) {
  const button = event.target.closest("[data-act]");
  const article = event.target.closest(".message");
  if (!article) return;
  if (!button) {
    // A tap on a phone shows the actions.
    article.classList.toggle("show-actions");
    return;
  }
  const m = state.messages.find((x) => x.id === article.dataset.id);
  if (!m) return;
  const act = button.dataset.act;
  if (act === "edit") return startEdit(article, m);
  if (act === "copy") return navigator.clipboard?.writeText(m.content);
  if (act === "delete") {
    if (!confirm("Delete this message?")) return;
    await attempt(() => api("DELETE", `/api/messages/${m.id}`));
    return refresh();
  }
  if (act === "prev" || act === "next") {
    await attempt(() => api("PATCH", `/api/messages/${m.id}`, { swipeIndex: m.swipeIndex + (act === "next" ? 1 : -1) }));
    return refresh();
  }
  if (act === "regen") return run(() => api("POST", `/api/chats/${state.chatId}/regenerate`));
}

function startEdit(article, m) {
  const body = article.querySelector(".message-body");
  body.outerHTML = `<form class="message-edit"><textarea>${escapeHtml(m.content)}</textarea>
    <div class="row end"><button type="button" class="button" data-cancel>Cancel</button><button type="submit" class="button primary">Save</button></div></form>`;
  const form = article.querySelector(".message-edit");
  const area = form.querySelector("textarea");
  area.focus();
  form.querySelector("[data-cancel]").addEventListener("click", () => renderMessages());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await attempt(() => api("PATCH", `/api/messages/${m.id}`, { content: area.value }));
    refresh();
  });
}

async function refresh() {
  if (!state.chatId) return;
  await attempt(async () => applyView(await api("GET", `/api/chats/${state.chatId}`)));
}

/** Run a request that writes a reply, showing "writing…" while it does. */
async function run(request) {
  state.busy = true;
  renderChat();
  const view = await attempt(request);
  state.busy = false;
  if (view) applyView(view);
  else refresh();
  await loadState();
  renderChatList();
}

// ------------------------------------------------------------- composer

async function send(event) {
  event.preventDefault();
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
  input.style.height = `${input.scrollHeight + 2}px`;
}

// --------------------------------------------------------- chat settings

export function openChatSettings() {
  if (!state.chat) return;
  $("chat-name-input").value = state.chat.name;
  renderCast();
  openDialog("chat-dialog");
}

function renderCast() {
  const cast = state.chat.cast;
  $("cast-list").innerHTML =
    cast
      .map((id, i) => {
        const c = cardById(id);
        if (!c) return "";
        const tag = c.isPersona ? `<span class="tag">you</span>` : c.isCharacter ? "" : `<span class="tag">world</span>`;
        return `<li data-i="${i}"><span class="name">${escapeHtml(c.name)}</span>${tag}
          <button type="button" class="icon-button" data-remove title="Remove from cast">✕</button></li>`;
      })
      .join("") || `<li class="muted small">No cards in this chat yet.</li>`;
  const free = state.cards.filter((c) => !cast.includes(c.id));
  $("cast-add").innerHTML = `<option value="">${free.length ? "Choose a card…" : state.cards.length ? "Every card is in the cast" : "No cards yet: open Cards to import"}</option>` + free.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.isPersona ? " (you)" : ""}</option>`).join("");
}

async function saveCast(cast) {
  const chat = await attempt(() => api("PATCH", `/api/chats/${state.chatId}`, { cast }));
  if (!chat) return;
  state.chat = chat;
  renderCast();
  renderChat();
}

// ----------------------------------------------------------------- sidebar

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("scrim").hidden = true;
}

export function wireChat() {
  $("chat-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-chat]");
    if (b) openChat(b.dataset.chat);
  });
  $("new-chat").addEventListener("click", newChat);
  $("messages").addEventListener("click", onMessageAction);
  $("composer").addEventListener("submit", send);
  $("composer-input").addEventListener("input", autosize);
  $("composer-input").addEventListener("keydown", (e) => {
    // Enter sends on a computer; on a phone it's a new line.
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("stop").addEventListener("click", () => api("POST", `/api/chats/${state.chatId}/stop`).catch(() => {}));
  $("open-chat-settings").addEventListener("click", openChatSettings);
  $("menu").addEventListener("click", () => {
    $("sidebar").classList.add("open");
    $("scrim").hidden = false;
  });
  $("scrim").addEventListener("click", closeSidebar);

  $("chat-name-input").addEventListener("change", async (e) => {
    const chat = await attempt(() => api("PATCH", `/api/chats/${state.chatId}`, { name: e.target.value }));
    if (!chat) return;
    state.chat = chat;
    await loadState();
    renderChat();
    renderChatList();
  });
  $("cast-list").addEventListener("click", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    const i = Number(li.dataset.i);
    const cast = [...state.chat.cast];
    if (e.target.closest("[data-remove]")) {
      cast.splice(i, 1);
      return saveCast(cast);
    }
  });
  $("cast-add").addEventListener("change", (e) => {
    if (e.target.value) saveCast([...state.chat.cast, e.target.value]);
  });
  $("delete-chat").addEventListener("click", async () => {
    if (!confirm(`Delete "${state.chat.name}" and all its messages?`)) return;
    await attempt(() => api("DELETE", `/api/chats/${state.chatId}`));
    $("chat-dialog").close();
    await loadState();
    await openChat(state.chats[0]?.id ?? null);
  });
}
