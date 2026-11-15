/** Reading cards from markdown (src/cards.ts). */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardToMarkdown, parseCards } from "../src/cards.ts";

const sample = readFileSync(join(import.meta.dir, "fixtures", "sample-cards.md"), "utf8");

describe("parseCards", () => {
  test("reads a file of cards: its title block, then each card", () => {
    const cards = parseCards(sample);
    // The file's own title comes first, as a card with a description.
    expect(cards.map((c) => c.name)).toEqual(["Sample cards for tests", "Ada Vale", "Bo", "Cy", "The Night Market", "Old Town"]);
    const ada = cards[1]!;
    expect(ada.fields.map((f) => f.key)).toEqual(["description", "advanced"]);
    expect(ada.fields[0]!.content).toStartWith("Ada Vale, 27.");
    expect(ada.fields[1]!.content).toStartWith("[Voice]");
    expect(ada.fields[1]!.content).toEndWith("under long sleeves.");
    expect(cards[2]!.fields[1]).toEqual({ key: "custom", title: "Voice bank", content: '"You\'re doing the thing again. The quiet thing."' });
  });

  test("other headings become custom fields; text under the name is the description", () => {
    const [card] = parseCards("# Rumi\nA singer.\n\n## Voice bank\n\"Three minutes.\"\n\n## System Prompt\nStay in third person.");
    expect(card!.fields).toEqual([
      { key: "description", title: "Description", content: "A singer." },
      { key: "custom", title: "Voice bank", content: '"Three minutes."' },
      { key: "system", title: "System prompt", content: "Stay in third person." },
    ]);
  });

  test("ignores text before the first card, and headings inside code fences", () => {
    const cards = parseCards("Some notes\n\n# A\n## Description\n```\n# not a card\n```\n");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.fields[0]!.content).toBe("```\n# not a card\n```");
  });

  test("drops a trailing --- between cards", () => {
    const cards = parseCards("# A\n## Description\nOne.\n\n---\n\n# B\n## Description\nTwo.");
    expect(cards[0]!.fields[0]!.content).toBe("One.");
  });

  test("round-trips through markdown", () => {
    const card = { name: "Mira", fields: [{ title: "Description", content: "Dancer." }, { title: "Voice bank", content: "Low, dry." }] };
    expect(parseCards(cardToMarkdown(card))[0]).toEqual({
      name: "Mira",
      fields: [
        { key: "description", title: "Description", content: "Dancer." },
        { key: "custom", title: "Voice bank", content: "Low, dry." },
      ],
    });
  });
});
