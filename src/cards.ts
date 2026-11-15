/**
 * Cards in and out of markdown.
 *
 * A card file holds one or more cards. Each starts with a `# Name` heading,
 * and each `## Heading` under it is a field:
 *
 *   # Rumi Kang
 *   ## Description
 *   Rumi Kang, 23. ...
 *   ## Advanced Description
 *   [Identity & Dual Life] ...
 *   ## Voice bank
 *   ...
 *
 * `Description`, `Advanced Description` and `System Prompt` fill the card's
 * own fields (case doesn't matter); any other heading becomes a custom field
 * with that title. Text right under the name, before any `##`, is the
 * description when there's no Description heading. Anything before the
 * first `#` is ignored. Deeper headings (`###`) stay inside the field.
 */

import type { CardField, FieldKey } from "./types.ts";

/** The default fields, in the order they show and go into the prompt. */
export const DEFAULT_FIELDS: { key: Exclude<FieldKey, "custom">; title: string }[] = [
  { key: "description", title: "Description" },
  { key: "advanced", title: "Advanced description" },
  { key: "system", title: "System prompt" },
];

/** A card read from markdown, not yet saved. */
export interface ParsedCard {
  name: string;
  fields: Pick<CardField, "key" | "title" | "content">[];
}

const KNOWN: Record<string, Exclude<FieldKey, "custom">> = {
  description: "description",
  "advanced description": "advanced",
  advanced: "advanced",
  "system prompt": "system",
  system: "system",
};

/** Read every card in a markdown text. */
export function parseCards(text: string): ParsedCard[] {
  const cards: ParsedCard[] = [];
  let card: ParsedCard | null = null;
  let field: { key: FieldKey; title: string; lines: string[] } | null = null;
  let loose: string[] = [];
  let inFence = false;

  const closeField = () => {
    if (card && field) card.fields.push({ key: field.key, title: field.title, content: tidy(field.lines) });
    field = null;
  };
  const closeCard = () => {
    closeField();
    if (!card) return;
    const looseText = tidy(loose);
    if (looseText) {
      const description = card.fields.find((f) => f.key === "description");
      if (!description) card.fields.unshift({ key: "description", title: "Description", content: looseText });
      else description.content = `${looseText}\n\n${description.content}`.trim();
    }
    cards.push(card);
    card = null;
    loose = [];
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h1 = !inFence && /^#\s+(.+?)\s*#*\s*$/.exec(line);
    const h2 = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1) {
      closeCard();
      card = { name: h1[1]!.trim(), fields: [] };
    } else if (h2 && card) {
      closeField();
      const title = h2[1]!.trim();
      const key = KNOWN[title.toLowerCase()] ?? "custom";
      field = { key, title: key === "custom" ? title : DEFAULT_FIELDS.find((d) => d.key === key)!.title, lines: [] };
    } else if (field) {
      field.lines.push(line);
    } else if (card) {
      loose.push(line);
    }
  }
  closeCard();
  return cards.filter((c) => c.name !== "");
}

/** Lines to field text: trimmed of blank lines at either end, and of trailing `---` rules between cards. */
function tidy(lines: string[]): string {
  const text = lines.join("\n").trim();
  return text.replace(/\n+\s*(---|\*\*\*|___)\s*$/, "").trim();
}

/** A card written back out as markdown, in the format `parseCards` reads. */
export function cardToMarkdown(card: { name: string; fields: Pick<CardField, "title" | "content">[] }): string {
  const parts = [`# ${card.name}`];
  for (const f of card.fields) if (f.content.trim()) parts.push(`## ${f.title}\n${f.content.trim()}`);
  return parts.join("\n\n") + "\n";
}
