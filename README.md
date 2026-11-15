# Anoesia

A small, single-user RP app. Version 1 is done when Rumi, Mira and Zoey play
smoothly in narrator-style scenes, with turns that leave room to respond.
The design is in the project's design doc; this README is what works today.

Pieces are lifted from [Amaedori](https://github.com/lumiivera-cmyk/amaedori)
(the nanoGPT and Vertex AI connection, the login) rather than forked.

## What works (steps 1 and 2 of the v1 plan, in the lacquer design)

- **Chats**, each with a **cast**: the cards in it, in the order they go into
  the prompt. Reorder them in chat settings.
- **Cards** with a name, description, advanced description and system prompt,
  plus custom fields (a voice bank, say). A card can be your persona ("This is
  me", which fills `{{user}}`) or not a character at all (a world or faction,
  left out of `{{cast}}`).
- **Import cards from markdown**: `# Name`, then `## Description`,
  `## Advanced Description`, `## System Prompt`, or any other `## Heading` for
  a custom field. Several cards per file; you see what was found before
  anything is saved.
- **Narrator-style replies**: one reply covers the whole scene. A line of
  `---` in a reply shows as a scene divider. Every message stores who wrote it.
- **Send, edit, regenerate, delete**, and versions: regenerating keeps the
  earlier reply as another version you can go back to. Send with an empty box
  lets the narrator go on.
- **Preview**: exactly what the model gets next, block by block (with each
  block's role and source) or as sent.
- **Connection profiles** on nanoGPT or Google Vertex AI, from Amaedori.
- **The prompts page**: every block of a chat's prompt, in send order. The
  main prompt, each card field, your own text blocks, and the chat history
  are blocks you drag (or move with arrows) into any order, per chat. Each
  block shows its role (system, user or assistant, changeable), an on/off
  switch, and a token count, and can go *inside the chat*, a set number of
  messages from the end. A card's fields fold into one group. Card fields and
  the main prompt are linked: editing them here edits the card, or the main
  prompt every chat shares.
- **Macros**, with Lumiverse's names and syntax so its cards keep working:
  `{{user}}`, `{{char}}`, `{{cast}}` (or `{{group}}`), `{{lastMessage}}`,
  `{{lastUserMessage}}`, `{{lastCharMessage}}`, `{{messageCount}}`,
  `{{date}}`, `{{time}}`, `{{weekday}}`, `{{isodate}}`, `{{isotime}}`,
  `{{random::a::b}}`, `{{pick::a::b}}`, `{{roll::2d6}}`, chat variables
  (`{{setvar::k::v}}`, `{{getvar::k}}`, `addvar`, `incvar`, `decvar`,
  `hasvar`, `deletevar`), global ones (the same with `gvar`), `{{newline}}`,
  `{{space}}`, `{{noop}}` and `{{// comments}}`. Variables change only when a
  prompt is really sent, never on Preview.
- **A login**, for running it on a server (see [hosting](docs/hosting.md)).

- **The lacquer design**: black lacquer panels over a night-city photo, the
  same on phone and desktop. In settings, pick the photo (or none), the
  finish (roiro, tamenuri or shunkei), how much the photo tints the panels,
  how dim it is and how much it shows through. "Back to readable" puts dim
  and window back. Each card has a bead colour: violet, blue, pink or any
  colour from the picker.
- **The cards page**: every card by kind, its fields in send order (drag the
  bumps, use the arrow keys, or tap them for move options), where it's used,
  and what deleting it would take with it. Reordering a card's fields also
  reorders its folder in every chat.

A new chat's prompt starts as: main prompt, each cast card's fields in cast
order, then the chat. A card you add to the cast later lands just before the
chat history.

## Running it

You need [Bun](https://bun.sh) and a nanoGPT API key (or Vertex AI).

```sh
git clone https://github.com/lumiivera-cmyk/anoesia.git
cd anoesia
bun install          # only for tests and type checking
cp .env.example .env # then set NANOGPT_API_KEY
bun start
```

Then open <http://127.0.0.1:4950>. (Amaedori uses 4949, so both can run.)

To run it on the Amaedori server, always up: [docs/hosting.md](docs/hosting.md).

## The design

`public/anoesia.css` is the design system from the design handoff, copied
as is: tokens, glass and lacquer surfaces, beads, buttons, switches. The
app's own layout is in `public/app.css`. The six background photos are in
`public/photos`, with their framing and tint in `public/js/theme.js`. The selenite
theme is designed but not built yet.

Not in this version, though designed: nudges and the agent (steps 3 and 4).

## Developing

```sh
bun test
bun run typecheck
```

To check the pages themselves (accessibility, every control, layout, touch
size and contrast, at desktop and phone sizes): [scripts/ui-check](scripts/ui-check/README.md).
