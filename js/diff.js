// Word-level diff of two texts, and the counts shown under each output in the compare view.
// Pure: no DOM, so the same code runs in the browser and under `node --test`.
//
// How diffWords works:
//   1. Split both texts into paragraphs (blocks separated by a blank line) and pair each
//      paragraph with its counterpart by the words they share. A paragraph with no
//      counterpart is removed or added whole, so changes never smear across paragraphs.
//   2. Diff each pair word by word (longest common subsequence). Punctuation marks are
//      tokens of their own, so "sat." → "sat down." adds "down" rather than replacing "sat.".
//   3. Tidy the result so it reads as a few clear edits: slide an insertion or deletion past
//      a repeated word so it stays in one piece, and fold a lone short word stranded between
//      two larger changes into them.

// A token is a word (letters, digits and marks, joined by apostrophes or hyphens, as in
// "don't" or "well-known") or a single punctuation mark, with the whitespace in front of it.
const TOKEN = /(\s*)([\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*|[^\s\p{L}\p{N}\p{M}])/gu;
const HAS_WORD = /[\p{L}\p{N}]/u;
const LIST_MARKER = /^\s*(?:[-*]|\d+\.)\s+/;
const ENDS_IN_WORD = /[\p{L}\p{N}\p{M}]$/u;
const STARTS_WITH_WORD = /^[\p{L}\p{N}\p{M}]/u;

// Paragraphs pair up only when at least this share of their words match (Dice coefficient).
const PAIR_THRESHOLD = 0.3;
// Beyond this many table cells, a paragraph pair is shown as replaced rather than diffed.
const MAX_CELLS = 4_000_000;

// Returns [{ type: 'same' | 'remove' | 'add', text }]. Joining the 'same' and 'remove' texts
// gives `a`, and joining the 'same' and 'add' texts gives `b`, apart from whitespace: the
// merged view borrows spacing from either side so words never run together, and paragraphs
// are separated by exactly one blank line.
export function diffWords(a, b) {
  const left = paragraphs(a).map(prepare);
  const right = paragraphs(b).map(prepare);
  const segments = [];
  alignParagraphs(left, right).forEach((step, index) => {
    if (index > 0) push(segments, 'same', '\n\n');
    let items;
    if (step.type === 'pair') {
      const runs = toRuns(diffTokens(left[step.a].tokens, right[step.b].tokens));
      items = itemsFromRuns(foldStrandedWords(slideEdits(runs)));
    } else {
      const tokens = step.type === 'remove' ? left[step.a].tokens : right[step.b].tokens;
      items = tokens.map((token) => ({ type: step.type, lead: token.lead, text: token.text }));
    }
    for (const item of separateWords(items)) push(segments, item.type, item.lead + item.text);
  });
  return segments;
}

// Words, paragraphs and list items (lines starting with "-", "*" or a number and a period).
// A word is anything between spaces with a letter or digit in it; list markers don't count.
export function textStats(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  return {
    words: lines
      .flatMap((line) => line.replace(LIST_MARKER, '').split(/\s+/))
      .filter((piece) => HAS_WORD.test(piece)).length,
    paragraphs: paragraphs(normalized).length,
    listItems: lines.filter((line) => LIST_MARKER.test(line)).length,
  };
}

// Blocks of text separated by one or more blank lines, without trailing whitespace.
// Indentation at the start of a paragraph is kept.
function paragraphs(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t]*\n)+/)
    .map((paragraph) => paragraph.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, ''))
    .filter((paragraph) => paragraph.trim() !== '');
}

function prepare(paragraph) {
  const tokens = Array.from(paragraph.matchAll(TOKEN), (match) => ({ lead: match[1], text: match[2] }));
  const words = tokens.filter((token) => HAS_WORD.test(token.text)).map((token) => token.text.toLowerCase());
  return { tokens, words };
}

// Share of words two paragraphs have in common, from 0 to 1.
function similarity(aWords, bWords) {
  if (aWords.length === 0 && bWords.length === 0) return 1;
  const counts = new Map();
  for (const word of aWords) counts.set(word, (counts.get(word) ?? 0) + 1);
  let common = 0;
  for (const word of bWords) {
    const count = counts.get(word);
    if (count) {
      common += 1;
      counts.set(word, count - 1);
    }
  }
  return (2 * common) / (aWords.length + bWords.length);
}

// Pairs paragraphs in order so the total similarity of the pairs is as high as possible.
// Returns steps: { type: 'pair', a, b }, { type: 'remove', a } or { type: 'add', b }.
function alignParagraphs(left, right) {
  const n = left.length;
  const m = right.length;
  const sims = left.map((p) => right.map((q) => similarity(p.words, q.words)));
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      let best = Math.max(score[i - 1][j], score[i][j - 1]);
      const sim = sims[i - 1][j - 1];
      if (sim >= PAIR_THRESHOLD) best = Math.max(best, score[i - 1][j - 1] + sim);
      score[i][j] = best;
    }
  }
  // Walk back from the end. Checking "add" before "remove" puts removals first in the result.
  const steps = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const sim = sims[i - 1][j - 1];
      if (sim >= PAIR_THRESHOLD && score[i][j] === score[i - 1][j - 1] + sim) {
        steps.push({ type: 'pair', a: i - 1, b: j - 1 });
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (j > 0 && (i === 0 || score[i][j] === score[i][j - 1])) {
      steps.push({ type: 'add', b: j - 1 });
      j -= 1;
    } else {
      steps.push({ type: 'remove', a: i - 1 });
      i -= 1;
    }
  }
  return steps.reverse();
}

// Edit script between two token lists: [{ type: 'same', a, b } | { type: 'remove', a } | { type: 'add', b }].
function diffTokens(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start].text === b[start].text) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1].text === b[endB - 1].text) {
    endA -= 1;
    endB -= 1;
  }
  const ops = [];
  for (let k = 0; k < start; k += 1) ops.push({ type: 'same', a: a[k], b: b[k] });
  ops.push(...longestCommon(a.slice(start, endA), b.slice(start, endB)));
  for (let k = 0; k < a.length - endA; k += 1) ops.push({ type: 'same', a: a[endA + k], b: b[endB + k] });
  return ops;
}

function longestCommon(a, b) {
  const n = a.length;
  const m = b.length;
  const removeAll = () => a.map((token) => ({ type: 'remove', a: token }));
  const addAll = () => b.map((token) => ({ type: 'add', b: token }));
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) return [...removeAll(), ...addAll()];

  // lengths[i * width + j] = length of the longest common subsequence of a[i..] and b[j..].
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i].text === b[j].text
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      ops.push({ type: 'same', a: a[i], b: b[j] });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      ops.push({ type: 'remove', a: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', b: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: 'remove', a: a[i++] });
  while (j < m) ops.push({ type: 'add', b: b[j++] });
  return ops;
}

// Groups the edit script into alternating runs: { same: [[a, b], …] } and { removed: […], added: […] }.
function toRuns(ops) {
  const runs = [];
  for (const op of ops) {
    const isSame = op.type === 'same';
    let run = runs[runs.length - 1];
    if (!run || Boolean(run.same) !== isSame) {
      run = isSame ? { same: [] } : { removed: [], added: [] };
      runs.push(run);
    }
    if (isSame) run.same.push([op.a, op.b]);
    else if (op.type === 'remove') run.removed.push(op.a);
    else run.added.push(op.b);
  }
  return runs;
}

// An insertion (or deletion) can often sit in more than one place: "number [(]the[ bottom)
// the] same" is the same edit as "number [(the bottom)] the same". When a one-sided edit
// ends with the whole unchanged stretch before it, or starts with the whole stretch after
// it, slide it over that stretch so the stretch disappears and the edit joins its neighbour.
function slideEdits(runs) {
  const matches = (tokens, stretch, side, atEnd) => {
    if (tokens.length < stretch.length) return false;
    const offset = atEnd ? tokens.length - stretch.length : 0;
    return stretch.every((pair, index) => tokens[offset + index].text === pair[side].text);
  };
  let slid = true;
  while (slid) {
    slid = false;
    for (let k = 1; k < runs.length - 1 && !slid; k += 1) {
      const [before, edit, after] = [runs[k - 1], runs[k], runs[k + 1]];
      if (!before.same || edit.same || !after.same) continue;
      const adding = edit.removed.length === 0;
      if (!adding && edit.added.length > 0) continue; // a replacement has no single place to slide
      const side = adding ? 1 : 0; // which half of each unchanged [older, newer] pair the edit's tokens belong to
      const tokens = adding ? edit.added : edit.removed;
      // Pairs an unchanged token from the other side with a token that leaves the edit.
      const pairWith = (pair, token) => (adding ? [pair[0], token] : [token, pair[1]]);
      let moved = null;
      if (matches(tokens, before.same, side, true)) {
        const leaving = tokens.slice(tokens.length - before.same.length);
        moved = [...before.same.map((pair) => pair[side]), ...tokens.slice(0, tokens.length - before.same.length)];
        after.same = [...before.same.map((pair, index) => pairWith(pair, leaving[index])), ...after.same];
        runs.splice(k - 1, 1);
      } else if (matches(tokens, after.same, side, false)) {
        const leaving = tokens.slice(0, after.same.length);
        moved = [...tokens.slice(after.same.length), ...after.same.map((pair) => pair[side])];
        before.same = [...before.same, ...after.same.map((pair, index) => pairWith(pair, leaving[index]))];
        runs.splice(k + 1, 1);
      }
      if (moved) {
        if (adding) edit.added = moved;
        else edit.removed = moved;
        joinNeighbours(runs);
        slid = true;
      }
    }
  }
  return runs;
}

function joinNeighbours(runs) {
  for (let k = runs.length - 1; k > 0; k -= 1) {
    const [first, second] = [runs[k - 1], runs[k]];
    if (Boolean(first.same) !== Boolean(second.same)) continue;
    if (first.same) first.same.push(...second.same);
    else {
      first.removed.push(...second.removed);
      first.added.push(...second.added);
    }
    runs.splice(k, 1);
  }
}

// A lone unchanged word between two changes at least twice its size is folded into them, so
// "I really like green apples" → "you never like red pears" reads as one replacement rather
// than two split around "like". Longer shared stretches stay: they show what the texts share.
function foldStrandedWords(runs) {
  const size = (tokens) => tokens.reduce((sum, token) => sum + token.lead.length + token.text.length, 0);
  let folded = true;
  while (folded) {
    folded = false;
    for (let k = 1; k < runs.length - 1; k += 1) {
      const [before, same, after] = [runs[k - 1], runs[k], runs[k + 1]];
      if (!same.same || before.same || after.same) continue;
      const newer = same.same.map(([, bToken]) => bToken);
      if (newer.filter((token) => HAS_WORD.test(token.text)).length > 1) continue;
      const length = size(newer);
      const beforeLength = Math.max(size(before.removed), size(before.added));
      const afterLength = Math.max(size(after.removed), size(after.added));
      if (length * 2 <= beforeLength && length * 2 <= afterLength) {
        runs.splice(k - 1, 3, {
          removed: [...before.removed, ...same.same.map(([aToken]) => aToken), ...after.removed],
          added: [...before.added, ...newer, ...after.added],
        });
        folded = true;
        break;
      }
    }
  }
  return runs;
}

// Unchanged tokens take the newer text's spacing (or the older's where the newer has none).
// In a replacement the removed and added text fill the same gap: the removed text takes the
// gap's spacing, and one space separates it from the added text, unless the change is glued
// to the word before it (as in "Hello.!").
function itemsFromRuns(runs) {
  const items = [];
  for (const run of runs) {
    if (run.same) {
      for (const [aToken, bToken] of run.same) items.push({ type: 'same', lead: bToken.lead || aToken.lead, text: bToken.text });
      continue;
    }
    const replacing = run.removed.length > 0 && run.added.length > 0;
    const gap = replacing ? run.added[0].lead || run.removed[0].lead : '';
    const between = gap || items.length === 0 ? ' ' : '';
    run.removed.forEach((token, index) =>
      items.push({ type: 'remove', lead: replacing && index === 0 ? gap : token.lead, text: token.text }),
    );
    run.added.forEach((token, index) =>
      items.push({ type: 'add', lead: replacing && index === 0 ? between : token.lead, text: token.text }),
    );
  }
  return items;
}

// Within one text, two words always have whitespace between them. In the merged view a
// word from one side can land right after a word from the other; give it a space.
function separateWords(items) {
  for (let k = 1; k < items.length; k += 1) {
    if (!items[k].lead && ENDS_IN_WORD.test(items[k - 1].text) && STARTS_WITH_WORD.test(items[k].text)) {
      items[k].lead = ' ';
    }
  }
  return items;
}

function push(segments, type, text) {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === type) last.text += text;
  else segments.push({ type, text });
}
