# Anoesia

A small, single-user RP app. Version 1 is done when Rumi, Mira and Zoey play
smoothly in narrator-style scenes, with turns that leave room to respond.
The design is in the project's design doc; this README is what works today.

Pieces are lifted from [Amaedori](https://github.com/lumiivera-cmyk/amaedori)
(the nanoGPT and Vertex AI connection, the login) rather than forked.

## What works (steps 1 to 4 of the v1 plan, in the lacquer design)

- **Chats**, each with a **cast**: the cards in it, in the order they go into
  the prompt. Reorder them in chat settings.
- **Onstage and offstage**, per chat. Onstage, a card's every field goes
  into the prompt, custom fields (a voice bank) included. Offstage, only its
  Description does: its other blocks stay on the prompts page, marked
  "offstage in this chat, not sent", and `{{cast}}` lists onstage characters
  only, so the main prompt never invites someone who isn't in the scene. On
  a computer each cast chip in the chat header is the switch (one tap); the
  **scene** button by the composer has the same switches, on a phone too.
- **Chat notes**: every chat has two notes of its own, **Right now** (where
  the story stands) and **Who knows what** (one line per secret). They're
  blocks on the prompts page like any other (move them, change their role,
  switch them off), sent under their title as a heading, and nothing at all
  while empty. Edit them from the scene menu, one tap each. Cards describe
  who someone is; story state belongs here.
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
- **Settings**, a page of its own (the sidebar's Settings, or the chats
  drawer on a phone), in four sections, each with a live one-line summary
  in the section list:
  - **Connections**: which profile writes story replies and which runs the
    agent, with each one's status from its last real request ("connected ·
    1.4 s", or "failing · key rejected" with a "fix the key" button);
    profiles, each with a searchable model list from the provider,
    temperature, longest reply, and Top P, min P, reasoning and extra JSON
    under "more controls"; and the providers: the nanoGPT key, and Vertex
    AI's project, region and service account key, each with a test. Keys
    set here are kept in the data folder (readable by the server only) and
    win over `.env`; only a key's last four characters come back to the page.
  - **Look**: the background, with a live preview (below).
  - **Agent**: what it runs on, its notes and its edit log.
  - **Typing**: Enter sends on a computer, or adds a line (then Ctrl+Enter
    sends). On a phone Enter always adds a line.
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
  profile (Settings → Connections → the agent), so it can be a tool-calling
  model while another writes replies. It sees Anoesia as paths:
  `cards/<card>/<field>`, `prompt/main`, `chats/<chat>/messages/<n>`,
  `chats/<chat>/blocks/<block>` (the chat's notes too), `chats/<chat>/cast`
  (one "Name: onstage" or "Name: offstage" line each, to read or flip), and its own files under `agent/`
  (`index.md`, read at the start of every session; `personality.md`;
  `notes/` for drafts; `chats/<chat>/` for each chat). Its tools: list, read,
  grep, edit (find and replace), write, delete, preview the prompt, fill
  macros, count tokens, ask you a question with choices, remember a note, and
  list or revert its changes. It changes your things only when you ask.
  Every change is logged with its text before and after, shown as a diff
  under the turn that made it, and can be reverted one at a time or a whole
  turn at once. Sessions are kept.
- **Nudges** (on the prompts page, next to "text block"): **match my pace**
  and **scene restraint** add a note right after your post, as you (depth 0),
  where models follow it best. Match my pace is `{{paceNote}}`: "My post was
  about N words, in N paragraphs. Match my pace: keep yours about that long,
  N words at most…", from Kinaera, and left out when the narrator is going on
  without a post from you. To word it your own way, use `{{lastUserWords}}`,
  `{{lastUserParagraphs}}` and `{{paceLimit}}`. Both are ordinary blocks:
  reword, move or switch them off.
- **Each chat's own agent** ("<chat>'s agent" at the top of the agent panel):
  the same tools, bound to one chat, with its own personality
  (`agent/chats/<chat>/personality.md`, yours to rewrite) and a notebook for
  the story (`notebook.md`), which it reads every turn and `remember` writes
  to. The notebook is never sent to the roleplay model. It changes things only
  when asked, like the main agent, and its sessions stay with its chat.

- **A login**, for running it on a server (see [hosting](docs/hosting.md)).

- **The lacquer design**: black lacquer panels over a night-city photo, the
  same on phone and desktop. In Settings → Look, add your own photos (they're
  kept in the data folder, behind the login, and never in git), pick one or
  none, the finish (roiro, tamenuri or shunkei), how much the photo tints the
  panels, how dim it is and how much it shows through. "Back to readable" puts
  dim and window back. Settings itself never gets dimmer or more see-through
  than the readable defaults, so you can always read your way back; the
  preview shows the real result. Each card has a bead colour: violet, blue, pink or any
  colour from the picker.
- **Selenite, in Settings**: pick Selenite under Settings → Look and Settings
  turns to crystal plates that bend the photo behind them (or neon tubes, if
  you pick no photo), on phone and desktop. The rest of the app stays lacquer
  until each page gets its selenite pass.
- **The cards page**: every card by kind, its fields in send order (drag the
  bumps, use the arrow keys, or tap them for move options), where it's used,
  and what deleting it would take with it. Reordering a card's fields also
  reorders its folder in every chat.

A new chat's prompt starts as: main prompt, each cast card's fields in cast
order, the chat's two notes, then the chat. A card you add to the cast later
lands just before the notes and the chat history.

## Running it

You need [Bun](https://bun.sh) and a nanoGPT API key (or Vertex AI).

```sh
git clone https://github.com/lumiivera-cmyk/anoesia.git
cd anoesia
bun install          # only for tests and type checking
cp .env.example .env # optional: NANOGPT_API_KEY, or add the key in Settings
bun start
```

Then open <http://127.0.0.1:4950>. (Amaedori uses 4949, so both can run.)

To run it on the Amaedori server, always up: [docs/hosting.md](docs/hosting.md).

## The design

`public/anoesia.css` is the design system from the design handoff, copied
as is: tokens, glass and lacquer surfaces, beads, buttons, switches. The
app's own layout is in `public/app.css`. No photos ship with the app: the
design's six came from a wallpaper site with no licence to share them, so
you upload your own in settings. Each photo's tint is worked out from its
colours when it's added.

Selenite's crystal plates are painted in the browser, not shipped as images:
`public/js/selenite/paint.js` is a port of the handoff's `make_selenite.py`
(the displacement map, mask, crystal, light and under-glow for one outline),
run in a worker. `plates.js` holds the outlines from the handoff's layout
files, fits them to each plate's real size, and keeps what it painted in the
browser's cache, so a plate repaints only when its size changes. Chromium
bends the photo through an SVG displacement filter; Safari and Firefox get
the same plates over a plain blur.

Not in this version, though designed: nudges (step 4).

## Developing

```sh
bun test
bun run typecheck
```

To check the pages themselves (accessibility, every control, layout, touch
size and contrast, at desktop and phone sizes): [scripts/ui-check](scripts/ui-check/README.md).
