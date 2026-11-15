/**
 * A word-level diff, for showing what an edit changed. Words, punctuation
 * marks and the whitespace between them are the units, so a one-word fix in a long
 * paragraph shows as one word, not the whole paragraph.
 */

export type DiffPart = { op: "same" | "add" | "del"; text: string };

/** The cells of the comparison table above which we compare by line instead. */
const MAX_CELLS = 4_000_000;

function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu) ?? [];
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** What turns `before` into `after`, as runs of kept, added and removed text. */
export function diff(before: string, after: string): DiffPart[] {
  let a = tokens(before);
  let b = tokens(after);
  if (a.length * b.length > MAX_CELLS) {
    a = lines(before);
    b = lines(after);
  }
  // Trim the shared start and end first: most edits touch a small middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const parts: DiffPart[] = [];
  const push = (op: DiffPart["op"], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last && last.op === op) last.text += text;
    else parts.push({ op, text });
  };
  push("same", a.slice(0, start).join(""));

  if (midA.length * midB.length > MAX_CELLS) {
    push("del", midA.join(""));
    push("add", midB.join(""));
  } else {
    // Longest common subsequence, then walk it.
    const n = midA.length;
    const m = midB.length;
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * (m + 1) + j] = midA[i] === midB[j] ? table[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push("same", midA[i]!);
        i++;
        j++;
      } else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!) push("del", midA[i++]!);
      else push("add", midB[j++]!);
    }
    while (i < n) push("del", midA[i++]!);
    while (j < m) push("add", midB[j++]!);
  }
  push("same", a.slice(endA).join(""));
  return parts;
}

/**
 * The diff with long unchanged runs cut down to their edges, for showing
 * a small change in a long text.
 */
export function compactDiff(parts: DiffPart[], context = 80): DiffPart[] {
  return parts.map((p, index) => {
    if (p.op !== "same" || p.text.length <= context * 2 + 5) return p;
    const first = index === 0;
    const last = index === parts.length - 1;
    if (first) return { op: "same", text: "…" + p.text.slice(-context) };
    if (last) return { op: "same", text: p.text.slice(0, context) + "…" };
    return { op: "same", text: p.text.slice(0, context) + " … " + p.text.slice(-context) };
  });
}
