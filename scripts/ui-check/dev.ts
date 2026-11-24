// Dev harness: fake nanoGPT + app on :4950 with a seeded temp data dir.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const repo = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { loadConfig } = await import(`${repo}/src/config.ts`);
const { createApp } = await import(`${repo}/src/server.ts`);
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/models"))
      return Response.json({
        data: [
          { id: "test/model", name: "Test model", context_length: 32768 },
          { id: "test/long-context", context_length: 1000000 },
          { id: "test/thinker", context_length: 131072, capabilities: { reasoning: true } },
          ...Array.from({ length: 30 }, (_, i) => ({ id: `vendor-${i % 5}/model-${i}`, context_length: 8192 * (1 + (i % 8)) })),
        ],
      });
    // A key saved as "bad" is refused, like a revoked one (for the "connection failing" screens).
    if (req.headers.get("authorization") === "Bearer bad") return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
    const body: any = await req.json();
    await Bun.sleep(Number(process.env.DELAY ?? 300));
    // Streamed (story replies): a little reasoning, then the reply, a few words at a time (GAP ms apart).
    if (body.stream) {
      const reasoning = "Hana is early again. Ada should notice, but stay busy with the setlist. Keep it short and leave room for Hana to answer.";
      const reply = "Ada glances up from the setlist. *She sets the pen down.*\n\n\"You're early,\" she says. \"Again.\" She slides the sheet across the table, one corner curling where her wrist has been resting on it.";
      const words = (t: string) => t.match(/\S+\s*/g) ?? [];
      const chunks = [...words(reasoning).map((w) => ({ reasoning: w })), ...words(reply).map((w) => ({ content: w }))];
      const gap = Number(process.env.GAP ?? 60);
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(c) {
            try {
              for (const delta of chunks) {
                await Bun.sleep(gap);
                c.enqueue(enc.encode(`data: ${JSON.stringify({ model: body.model, choices: [{ delta }] })}\n\n`));
              }
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            } catch {
              // stopped
            }
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return Response.json({ model: body.model, choices: [{ message: { content: "Ada glances up from the setlist. *She sets the pen down.*\n\n\"You're early,\" she says. \"Again.\"" }, finish_reason: "stop" }] });
  },
});
const dir = mkdtempSync(join(tmpdir(), "anoesia-dev-"));
const app = createApp(loadConfig({ DATA_DIR: dir, NANOGPT_API_KEY: "k", NANOGPT_BASE_URL: `http://127.0.0.1:${fake.port}/v1` }));
Bun.serve({ port: 4950, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 0 });
const call = async (method: string, path: string, body?: unknown) => (await app.fetch(new Request(`http://127.0.0.1${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }))).json() as any;
if (!process.env.EMPTY) {
  await call("POST", "/api/profiles", { name: "Test", model: "test/model", temperature: 0.8 });
  const imported = (await call("POST", "/api/cards/import", { text: readFileSync(`${repo}/test/fixtures/sample-cards.md`, "utf8") })).cards;
  const id = (n: string) => imported.find((c: any) => c.name.startsWith(n)).id;
  await call("PATCH", `/api/cards/${id("Old Town")}`, { isCharacter: false });
  await call("PATCH", `/api/cards/${id("The Night Market")}`, { isCharacter: false, colour: "blue" });
  await call("PATCH", `/api/cards/${id("Bo")}`, { colour: "pink" });
  await call("PATCH", `/api/cards/${id("Cy")}`, { colour: "#4FD1A5" });
  const me = await call("POST", "/api/cards", { name: "Hana", isPersona: true, fields: [{ key: "description", content: "A new trainee." }] });
  // A long chat, its older messages folded into the story so far (made first, so Backstage stays the latest).
  const long = await call("POST", "/api/chats", { name: "Long run", cast: [id("Old Town"), me.id, id("Ada")] });
  for (let i = 1; i <= 14; i++) await call("POST", `/api/chats/${long.id}/send`, { content: `Turn ${i}. Hana runs the scales again, slower this time.` });
  await call("PATCH", `/api/chats/${long.id}`, { summaryKeep: 10 });
  await call("POST", `/api/chats/${long.id}/summary/fold`);
  const chat = await call("POST", "/api/chats", { name: "Backstage", cast: [id("Old Town"), id("The Night Market"), id("Bo"), id("Cy"), me.id, id("Ada")] });
  for (const t of ["*Hana knocks on the green room door.*", "Is this a bad time?", "I brought the new setlist."]) await call("POST", `/api/chats/${chat.id}/send`, { content: t });
  await call("POST", `/api/chats/${chat.id}/regenerate`, {});
  // Bo offstage, and one of the two notes filled, so both states show.
  await call("PATCH", `/api/chats/${chat.id}`, { offstage: [id("Bo")] });
  const now = (await call("GET", `/api/chats/${chat.id}/blocks`)).find((b: any) => b.title === "Right now");
  await call("PATCH", `/api/blocks/${now.id}`, { content: "The green room, an hour before doors. Ada is icing her wrist." });
  await call("POST", "/api/chats", { name: "Night market", cast: [id("The Night Market"), me.id, id("Bo")] });
  // A background photo, if you point PHOTO at one (none are in the repo).
  if (process.env.PHOTO) {
    const bytes = readFileSync(process.env.PHOTO);
    const photo = await (await app.fetch(new Request("http://127.0.0.1/api/photos?name=street&tint=%23111A26&position=50%25%2038%25", { method: "POST", body: bytes }))).json() as any;
    await call("PATCH", "/api/settings", { background: { photo: photo.id } });
  }
}
console.log("ready", dir);
