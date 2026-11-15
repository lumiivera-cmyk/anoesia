# Anoesia

A small, single-user RP app. Version 1 is done when Rumi, Mira and Zoey play
smoothly in narrator-style scenes, with turns that leave room to respond.
The design is in the project's design doc; this README is what works today.

Pieces are lifted from [Amaedori](https://github.com/lumiivera-cmyk/amaedori)
(the nanoGPT and Vertex AI connection, the login, the look) rather than forked.

## What works (step 1 of the v1 plan)

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
- **Macros**: `{{user}}`, `{{char}}`, `{{cast}}`, `{{date}}`, `{{time}}`,
  `{{// comments}}`.
- **A login**, for running it on a server (see [hosting](docs/hosting.md)).

The prompt is assembled in a fixed order for now: main prompt, then each
cast card, then the chat. The prompts page (step 2) makes that yours to
arrange.

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
