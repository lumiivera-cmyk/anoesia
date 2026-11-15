# Anoesia

A small, single-user RP app. Version 1 is done when Rumi, Mira and Zoey play
smoothly in narrator-style scenes, with turns that leave room to respond.
The design is in the project's design doc; this README is what works today.

Pieces are lifted from [Amaedori](https://github.com/lumiivera-cmyk/amaedori)
(the nanoGPT and Vertex AI connection, the login, the look) rather than forked.

## What works (steps 1 to 3a of the v1 plan)

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
- **The agent** (the Agent button), modelled on LumiAgent. It has its own
  profile (Settings → "The agent thinks with"), so it can be a tool-calling
  model while another writes replies. It sees Anoesia as paths:
  `cards/<card>/<field>`, `prompt/main`, `chats/<chat>/messages/<n>`,
  `chats/<chat>/blocks/<block>`, and its own files under `agent/`
  (`index.md`, read at the start of every session; `personality.md`;
  `notes/` for drafts; `chats/<chat>/` for each chat). Its tools: list, read,
  grep, edit (find and replace), write, delete, preview the prompt, fill
  macros, count tokens, ask you a question with choices, remember a note, and
  list or revert its changes. It changes your things only when you ask.
  Every change is logged with its text before and after, shown as a diff
  under the turn that made it, and can be reverted one at a time or a whole
  turn at once (combing a chat is one turn). A revert never silently undoes
  something you changed after the agent did. Sessions are kept.
- **A login**, for running it on a server (see [hosting](docs/hosting.md)).

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

## Developing

```sh
bun test
bun run typecheck
```
