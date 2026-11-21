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
import { isOffstage, openScene, stageLine, toggleStage } from "./scene.js";
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
  if (view) {
    applyView(view, false);
    // A reply is being written (the page was reloaded, or you came back to this chat): watch it arrive.
    if (view.busy) watchLive();
  } else {
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
  if (!view.busy) state.live = null;
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
  // Each chip is its card's onstage switch: one tap moves them on or off stage.
  $("cast-chips").innerHTML = cast
    .map((c) => {
      const off = isOffstage(c.id);
      return `<li><button type="button" class="${c.isPersona ? "sunk" : "raised"} press chip${off ? " is-offstage" : ""}" data-chip="${c.id}" aria-pressed="${!off}" title="${escapeHtml(c.name)}: ${stageLine(c.id)}. Tap to move ${off ? "onstage" : "offstage"}">${gem(c, 26)}${escapeHtml(c.name)}${c.isPersona ? ' <span class="chip-you">· you</span>' : ""}${off ? ' <span class="chip-you">· off</span>' : ""}</button></li>`;
    })
    .join("");
  const others = cast.filter((c) => !c.isPersona);
  const onNames = others.filter((c) => !isOffstage(c.id)).map(shortName);
  const offCount = others.length - onNames.length;
  const castLine = others.length ? `${onNames.join(", ") || "nobody onstage"}${offCount ? ` · ${offCount} off` : ""}` : "no cast yet";
  $("phone-title").innerHTML = `<span class="pt-name">${escapeHtml(chat ? chat.name : "Anoesia")}</span>
    <span class="pt-line">${others.length ? `<span class="pt-gems">${others.map((c) => gem(c, 12, { label: false, extraClass: isOffstage(c.id) ? "is-offstage" : "" })).join("")}</span>` : ""}<span class="meta">${escapeHtml(chat ? castLine : "")}</span></span>`;
  $("phone-title").setAttribute("aria-label", `${chat ? `${chat.name} ${castLine}` : "Anoesia"}: chat settings`);
  for (const id of ["go-preview", "go-prompts", "open-chat-settings", "phone-title", "open-scene"]) {
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
  if (state.busy) html += liveHtml();
  if (!html) {
    const castEmpty = !state.chat.cast.length;
    html = `<div class="empty raised"><p class="disp">Nothing here yet</p><p class="meta">${
      castEmpty ? "Add your cards to this chat's cast first, then write the opening." : "Write the opening, or press continue to let the narrator begin."
    }</p>${castEmpty ? `<button type="button" class="btn raised press" data-empty-cast>${icon.sliders(18)} chat settings</button>` : ""}</div>`;
  }
  box.innerHTML = html;
  if (state.busy) drawLive();
  if (scrollToEnd || atEnd) scroller.scrollTop = scroller.scrollHeight;
}

// ------------------------------------------------------------ the live reply

/**
 * The reply being written, as it arrives: its reasoning in a fold that's
 * open while the model thinks and folds away when the text starts (unless
 * you opened or closed it yourself), then the text with a caret.
 */
function liveHtml() {
  return `<article class="msg narrator live" aria-busy="true" aria-label="Narrator reply, being written">
    <div class="mhead"><span class="eyebrow">Narrator</span><span class="meta" role="status" data-live-status></span></div>
    <details class="thinking" data-live-thinking hidden${foldOpen ? " open" : ""}><summary>${icon.right(14)}<span data-live-thinking-label>thinking</span></summary><div class="thinking-body" data-live-reasoning></div></details>
    <div class="msg-body" data-live-text></div>
  </article>`;
}

/** Whether you've opened or closed the live fold yourself (then it stays as you left it), and whether it's open. */
let foldTouched = false;
let foldOpen = true;
let drawQueued = false;

/** Draw the live reply's words (at most once a frame). */
function queueLive() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const scroller = $("messages-scroll");
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    drawLive();
    if (atEnd) scroller.scrollTop = scroller.scrollHeight;
  });
}

function drawLive() {
  const box = $("messages");
  const fold = box.querySelector("[data-live-thinking]");
  if (!fold) return;
  const live = state.live ?? { reasoning: "", content: "" };
  const caret = `<span class="caret" aria-hidden="true">▍</span>`;
  const thinking = Boolean(live.reasoning) && !live.content;
  box.querySelector("[data-live-status]").innerHTML = `${thinking ? "thinking" : "writing"}${live.content ? "" : caret}`;
  if (live.reasoning) {
    fold.hidden = false;
    box.querySelector("[data-live-thinking-label]").textContent = live.content ? "reasoning" : "thinking";
    const body = box.querySelector("[data-live-reasoning]");
    const following = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.innerHTML = formatText(live.reasoning);
    if (following) body.scrollTop = body.scrollHeight;
    // The text has started: fold the thinking away, unless you've opened or closed it yourself.
    if (live.content && fold.open && !foldTouched) fold.open = false;
  }
  if (live.content) {
    const html = formatText(live.content);
    const end = html.lastIndexOf("</p>");
    box.querySelector("[data-live-text]").innerHTML = end >= 0 ? `${html.slice(0, end)}${caret}${html.slice(end)}` : html + caret;
  } else {
    box.querySelector("[data-live-text]").innerHTML = "";
  }
}

/** Which reply this page is watching (one at a time), so a stream from a chat you've left is let go. */
let watching = null;

/**
 * Follow a reply's events (see the server's `watch`) until it's done. If the
 * connection drops before then (the phone slept, the network blinked) and the
 * reply is still being written, watch it again from where it is.
 */
async function follow(chatId, open) {
  watching?.abort();
  const me = new AbortController();
  watching = me;
  const mine = () => watching === me && state.chatId === chatId;
  let done = false;
  for (let tries = 0; !done && tries < 6 && mine(); tries++) {
    if (tries) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** tries, 8000)));
    if (!mine()) break;
    let response;
    try {
      response = await (tries === 0 ? open(me.signal) : fetch(`api/chats/${chatId}/live`, { signal: me.signal }));
    } catch {
      continue;
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      // Refused (another reply is under way, or a check failed): the reason is in the JSON.
      const data = await response.json().catch(() => null);
      if (response.status === 401 && data?.login) location.href = "login";
      if (mine()) state.replyError = data?.error ?? `The server answered ${response.status}.`;
      break;
    }
    try {
      done = await readEvents(response, (event) => {
        if (!mine()) return;
        onEvent(event);
      });
    } catch {
      // dropped: try again
    }
  }
  if (watching === me) watching = null;
  if (!done && state.chatId === chatId) {
    // Gave up watching, or was refused: show the chat as the server has it.
    state.busy = false;
    state.live = null;
    await refresh();
    renderChat();
  }
}

/** Read server-sent events from a response, calling `each` with each one. Returns whether "done" arrived. */
async function readEvents(response, each) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return false;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      if (!block.startsWith("data: ")) continue;
      const event = JSON.parse(block.slice(6));
      each(event);
      if (event.type === "done") {
        reader.cancel().catch(() => {});
        return true;
      }
    }
  }
}

function onEvent(event) {
  if (event.type === "start") {
    state.live = event.live ?? { reasoning: "", content: "" };
    applyView(event, false);
    renderChat();
  } else if (event.type === "more") {
    state.live ??= { reasoning: "", content: "" };
    state.live.reasoning += event.reasoning ?? "";
    state.live.content += event.content ?? "";
    queueLive();
  } else if (event.type === "reply") {
    state.live = { reasoning: event.reasoning ?? "", content: event.content ?? "" };
    queueLive();
  } else if (event.type === "done") {
    state.live = null;
    state.replyError = event.error ?? null;
    applyView(event, false);
    renderChat();
    loadState().then(renderSide, () => {});
  }
}

/** Watch the reply that's being written in the open chat. */
function watchLive() {
  const chatId = state.chatId;
  if (!chatId || watching) return;
  state.live ??= { reasoning: "", content: "" };
  follow(chatId, (signal) => fetch(`api/chats/${chatId}/live`, { signal }));
}

function versionsHtml(m) {
  if (m.swipes.length < 2) return "";
  return `<span class="sunk versions">
    <button type="button" class="ghost press ib" data-act="prev" aria-label="Previous version" ${m.swipeIndex === 0 ? 'aria-disabled="true"' : ""}>${icon.left()}</button>
    <span class="vcount">${m.swipeIndex + 1} / ${m.swipes.length}</span>
    <button type="button" class="ghost press ib" data-act="next" aria-label="Next version" ${m.swipeIndex === m.swipes.length - 1 ? 'aria-disabled="true"' : ""}>${icon.right()}</button>
  </span>`;
}

/** Whether a saved "reasoning" is only the reply again (some providers sent that before it was caught; see src/nanogpt.ts echoes). */
function echoes(reasoning, content) {
  const r = reasoning.replace(/\s+/g, " ").trim();
  const c = content.replace(/\s+/g, " ").trim();
  return Boolean(r && c) && (c.startsWith(r) || r.startsWith(c));
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
  const thinking = !you && m.reasoning && !echoes(m.reasoning, m.content) ? `<details class="thinking"><summary>${icon.right(14)}<span>reasoning</span></summary><div class="thinking-body">${formatText(m.reasoning)}</div></details>` : "";
  return `<article class="msg ${you ? "you sunk" : "narrator"}" data-id="${m.id}" aria-label="${escapeHtml(label)}">
    ${head}
    ${thinking}
    <div class="msg-body">${formatText(m.content)}</div>
    ${phoneRow}
  </article>`;
}

async function onMessageClick(event) {
  if (event.target.closest("[data-empty-new]")) return newChat();
  if (event.target.closest("[data-empty-cast]")) return openChatSettings(event.target.closest("button"));
  // Opening or reading the reasoning isn't a tap on the message.
  if (event.target.closest(".thinking")) {
    if (event.target.closest("[data-live-thinking] summary")) foldTouched = true;
    return;
  }
  const article = event.target.closest(".msg");
  if (!article || article.classList.contains("editing") || article.classList.contains("live")) return;
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
  if (what === "regen") return run("regenerate");
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

/** Write a reply (`send` after your message, or `regenerate`), showing it as it arrives. */
async function run(what, body = {}) {
  const chatId = state.chatId;
  state.busy = true;
  state.live = { reasoning: "", content: "" };
  state.replyError = null;
  foldTouched = false;
  foldOpen = true;
  renderChat(true);
  await follow(chatId, (signal) =>
    fetch(`api/chats/${chatId}/${what}?stream=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }),
  );
  if (state.chatId === chatId) renderChat();
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
  await run("send", { content });
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
  $("dismiss-error").innerHTML = icon.close(18);

  $("messages").addEventListener("click", onMessageClick);
  $("cast-chips").addEventListener("click", async (e) => {
    const chip = e.target.closest("[data-chip]");
    if (!chip) return;
    const id = chip.dataset.chip;
    if (await toggleStage(id)) $("cast-chips").querySelector(`[data-chip="${CSS.escape(id)}"]`)?.focus();
  });
  document.addEventListener("anoesia:stage-changed", () => renderChat());
  $("composer").addEventListener("submit", send);
  $("continue").addEventListener("click", () => {
    if (!state.busy && state.chatId) run("send", { content: "" });
  });
  $("retry").addEventListener("click", () => {
    if (state.busy || !state.chatId) return;
    // A failed reply kept your message, so trying again lets the narrator answer it.
    const last = state.messages.at(-1);
    if (last?.role === "assistant") run("regenerate");
    else run("send", { content: "" });
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
  // Back from another app with a reply under way: pick it up again if the connection was lost.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.busy && !watching) watchLive();
  });
  // toggle doesn't bubble: listen on the way down. Keeps the live fold as it was when the chat is redrawn.
  $("messages").addEventListener(
    "toggle",
    (e) => {
      if (e.target.matches?.("[data-live-thinking]")) foldOpen = e.target.open;
    },
    true,
  );
  const guard = (fn) => (e) => {
    if (e.currentTarget.getAttribute("aria-disabled") === "true") {
      e.preventDefault();
      return;
    }
    fn(e);
  };
  $("open-chat-settings").addEventListener("click", guard((e) => openChatSettings(e.currentTarget)));
  $("phone-title").addEventListener("click", guard((e) => openChatSettings(e.currentTarget)));
  $("open-scene").addEventListener("click", guard((e) => openScene(e.currentTarget)));
  $("go-preview").addEventListener("click", guard(() => {}));
  $("go-prompts").addEventListener("click", guard(() => {}));
  wireChatDialog();
  void showError;
}
