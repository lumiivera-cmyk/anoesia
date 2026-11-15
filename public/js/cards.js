/**
 * Cards: the list, the editor, and markdown import.
 */

import { $, api, approxTokens, attempt, cardById, escapeHtml, loadState, openDialog, state } from "./core.js";
import { renderChat } from "./chat.js";

/** The card open in the editor (null for a new one). */
let editing = null;

function cardTokens(card) {
  return card.fields.reduce((n, f) => n + approxTokens(f.content), 0);
}

export function openCards() {
  renderCardList();
  openDialog("cards-dialog");
}

function renderCardList() {
  $("card-list").innerHTML =
    state.cards
      .map((c) => {
        const tag = c.isPersona ? `<span class="tag">you</span>` : c.isCharacter ? `<span class="tag">character</span>` : `<span class="tag">world</span>`;
        return `<li><button type="button" class="chat-link name" data-card="${c.id}">${escapeHtml(c.name)}</button>${tag}<span class="muted small">~${cardTokens(c)} tokens</span></li>`;
      })
      .join("") || `<li class="muted small">No cards yet. Import some markdown, or make a new one.</li>`;
}

// --------------------------------------------------------------- editor

function openEditor(card) {
  editing = card;
  $("card-dialog-title").textContent = card ? card.name : "New card";
  $("card-name").value = card?.name ?? "";
  $("card-persona").checked = card?.isPersona ?? false;
  $("card-character").checked = card?.isCharacter ?? true;
  const defaults = card?.fields.filter((f) => f.key !== "custom") ?? [
    { key: "description", title: "Description", content: "" },
    { key: "advanced", title: "Advanced description", content: "" },
    { key: "system", title: "System prompt", content: "" },
  ];
  $("card-fields").innerHTML = defaults
    .map(
      (f) => `<div class="field-block" data-key="${f.key}">
        <div class="field-head"><span>${escapeHtml(f.title)}</span><span class="spacer"></span><span class="muted small" data-count></span></div>
        <textarea rows="${f.key === "advanced" ? 10 : 4}">${escapeHtml(f.content)}</textarea></div>`,
    )
    .join("");
  const custom = card?.fields.filter((f) => f.key === "custom") ?? [];
  $("card-custom-fields").innerHTML = custom.map(customFieldHtml).join("");
  $("card-dialog").querySelector(".advanced").open = custom.length > 0;
  $("delete-card").hidden = !card;
  updateCounts();
  openDialog("card-dialog");
}

function customFieldHtml(f) {
  return `<div class="field-block" data-key="custom" data-id="${f.id ?? ""}">
    <div class="field-head"><input placeholder="Field title, e.g. Voice bank" value="${escapeHtml(f.title)}" />
      <span class="muted small" data-count></span>
      <button type="button" class="icon-button" data-remove-field title="Remove field">✕</button></div>
    <textarea rows="6">${escapeHtml(f.content)}</textarea></div>`;
}

function updateCounts() {
  let total = 0;
  for (const block of $("card-dialog").querySelectorAll(".field-block")) {
    const n = approxTokens(block.querySelector("textarea").value);
    total += n;
    block.querySelector("[data-count]").textContent = n ? `~${n} tokens` : "";
  }
  $("card-tokens").textContent = `~${total} tokens in all`;
}

function readEditor() {
  const fields = [...$("card-dialog").querySelectorAll(".field-block")].map((block) => {
    const key = block.dataset.key;
    const content = block.querySelector("textarea").value;
    if (key !== "custom") return { key, content };
    return { key, id: block.dataset.id || undefined, title: block.querySelector(".field-head input").value, content };
  });
  return { name: $("card-name").value, isPersona: $("card-persona").checked, isCharacter: $("card-character").checked, fields };
}

async function saveEditor(event) {
  event.preventDefault();
  const body = readEditor();
  const saved = await attempt(() => (editing ? api("PATCH", `/api/cards/${editing.id}`, body) : api("POST", "/api/cards", body)));
  if (!saved) return;
  await loadState();
  $("card-dialog").close();
  renderCardList();
  renderChat();
}

// --------------------------------------------------------------- import

let importTimer = 0;

async function previewImport() {
  const text = $("import-text").value;
  const box = $("import-preview");
  if (!text.trim()) {
    box.innerHTML = "";
    $("import-go").disabled = true;
    return;
  }
  const result = await attempt(() => api("POST", "/api/cards/import", { text, dryRun: true }));
  const cards = result?.cards ?? [];
  $("import-go").disabled = cards.length === 0;
  box.innerHTML = cards.length
    ? `<h3>${cards.length} card${cards.length === 1 ? "" : "s"} found</h3><ul class="card-list">${cards
        .map((c) => {
          const fields = c.fields.map((f) => `${escapeHtml(f.title)} (~${approxTokens(f.content)})`).join(", ");
          const taken = state.cards.some((x) => x.name.toLowerCase() === c.name.toLowerCase()) ? ` <span class="tag">name already used</span>` : "";
          return `<li><span class="name"><strong>${escapeHtml(c.name)}</strong>${taken}<br /><span class="muted small">${fields || "no fields"}</span></span></li>`;
        })
        .join("")}</ul>`
    : `<p class="muted small">No cards found yet. Each card starts with a line like <code># Name</code>.</p>`;
}

async function runImport() {
  const result = await attempt(() => api("POST", "/api/cards/import", { text: $("import-text").value }));
  if (!result) return;
  await loadState();
  $("import-text").value = "";
  $("import-preview").innerHTML = "";
  $("import-go").disabled = true;
  $("import-dialog").close();
  renderCardList();
  renderChat();
}

export function wireCards() {
  $("open-cards").addEventListener("click", openCards);
  $("new-card").addEventListener("click", () => openEditor(null));
  $("card-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-card]");
    if (b) openEditor(cardById(b.dataset.card));
  });
  $("card-form").addEventListener("submit", saveEditor);
  $("card-dialog").addEventListener("input", updateCounts);
  $("add-custom-field").addEventListener("click", () => {
    $("card-custom-fields").insertAdjacentHTML("beforeend", customFieldHtml({ title: "", content: "" }));
    $("card-custom-fields").lastElementChild.querySelector("input").focus();
  });
  $("card-custom-fields").addEventListener("click", (e) => {
    if (e.target.closest("[data-remove-field]")) {
      e.target.closest(".field-block").remove();
      updateCounts();
    }
  });
  $("delete-card").addEventListener("click", async () => {
    if (!editing) return;
    const using = state.chats.filter((c) => c.cast.includes(editing.id)).map((c) => c.name);
    const note = using.length ? ` It's in the cast of: ${using.join(", ")}.` : "";
    if (!confirm(`Delete ${editing.name}?${note}`)) return;
    await attempt(() => api("DELETE", `/api/cards/${editing.id}`));
    await loadState();
    if (state.chat) state.chat.cast = state.chat.cast.filter((id) => id !== editing.id);
    $("card-dialog").close();
    renderCardList();
    renderChat();
  });

  $("open-import").addEventListener("click", () => openDialog("import-dialog"));
  $("import-text").addEventListener("input", () => {
    clearTimeout(importTimer);
    importTimer = setTimeout(previewImport, 300);
  });
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $("import-text").value = await file.text();
    e.target.value = "";
    previewImport();
  });
  $("import-go").addEventListener("click", runImport);
}
