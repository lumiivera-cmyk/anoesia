/**
 * Nudges: short notes that steer the next reply, placed right after your
 * post (depth 0, as you), where models follow them best. They are ordinary
 * text blocks on the prompts page, so you can reword, move or switch them
 * off like any other. Ported from Kinaera's "match my pace".
 */

/** Your latest post: the run of your messages at the end of the chat (joined), or "" if the chat ends on a reply. */
export function latestUserPost(messages: { role: string; content: string }[]): string {
  const run: string[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role === "user"; i--) run.unshift(messages[i]!.content);
  return run.join("\n\n").trim();
}

/** How long a post is: words (exact under 20, else to the nearest 10), paragraphs, and the reply's upper limit. */
export function paceOf(post: string): { words: number; shownWords: number; paragraphs: number; limit: number } {
  const words = post.split(/\s+/).filter(Boolean).length;
  const paragraphs = post ? post.split(/\n\s*\n/).filter((p) => p.trim()).length : 0;
  const shownWords = words < 20 ? words : Math.max(10, Math.round(words / 10) * 10);
  return { words, shownWords, paragraphs, limit: Math.max(60, Math.round(words * 1.5)) };
}

export function paragraphsText(n: number): string {
  return n === 1 ? "one paragraph" : `${n} paragraphs`;
}

/** The full pace note, or "" when the chat doesn't end on your post (so the block is left out). */
export function paceNote(post: string): string {
  if (!post) return "";
  const p = paceOf(post);
  return `(OOC: My post was about ${p.shownWords} words, in ${paragraphsText(p.paragraphs)}. Match my pace: keep yours about that long, ${p.limit} words at most. Say what matters and stop where I can respond; don't pad or repeat.)`;
}

export interface NudgePreset {
  title: string;
  content: string;
  role: "user";
  depth: number;
}

export const NUDGES: Record<string, NudgePreset> = {
  pace: {
    title: "Match my pace",
    // {{paceNote}} is the whole sentence. To reword it, use {{lastUserWords}}, {{lastUserParagraphs}} and {{paceLimit}}.
    content: "{{paceNote}}",
    role: "user",
    depth: 0,
  },
  restraint: {
    title: "Scene restraint",
    content: "(OOC: Stop at the first point where {{user}} could respond. Don't decide what {{user}} says, does or feels, and don't skip past moments they'd want to play.)",
    role: "user",
    depth: 0,
  },
};
