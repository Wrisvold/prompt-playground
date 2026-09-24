// Element definitions and prompt assembly.
// Pure: no DOM and no storage, so the same code runs in the browser and under `node --test`.

import { CHARS_PER_TOKEN } from './constants.js';

// The seven elements, in the fixed order they are shown and assembled.
// `chip` is the two-letter code the run list uses (Context and Criteria share a first letter).
// Rules is the only element with sub-fields; a single plug covers all three.
export const ELEMENTS = [
  { id: 'persona', label: 'Persona', chip: 'Pe' },
  { id: 'task', label: 'Task', chip: 'Ta' },
  { id: 'context', label: 'Context', chip: 'Co' },
  { id: 'examples', label: 'Examples', chip: 'Ex' },
  {
    id: 'rules',
    label: 'Rules',
    chip: 'Ru',
    parts: [
      { id: 'do', label: 'Do' },
      { id: 'dont', label: "Don't" },
      { id: 'fallback', label: 'Fallback' },
    ],
  },
  { id: 'criteria', label: 'Criteria', chip: 'Cr' },
  { id: 'steps', label: 'Steps', chip: 'St' },
];

// The text keys an element holds: ['text'], or one per Rules sub-field.
export function textKeys(def) {
  return def.parts ? def.parts.map((part) => part.id) : ['text'];
}

// Every element plugged in and empty:
//   { persona: { plugged, text }, …, rules: { plugged, do, dont, fallback }, … }
export function createEmptyElements() {
  return Object.fromEntries(
    ELEMENTS.map((def) => [
      def.id,
      { plugged: true, ...Object.fromEntries(textKeys(def).map((key) => [key, ''])) },
    ]),
  );
}

// A new, complete elements object built from whatever `raw` holds (for example JSON read
// back from storage). Unknown keys are dropped; missing or mistyped values get defaults.
export function normalizeElements(raw) {
  const elements = createEmptyElements();
  if (!raw || typeof raw !== 'object') return elements;
  for (const def of ELEMENTS) {
    const source = raw[def.id];
    if (!source || typeof source !== 'object') continue;
    const target = elements[def.id];
    if (typeof source.plugged === 'boolean') target.plugged = source.plugged;
    for (const key of textKeys(def)) {
      if (typeof source[key] === 'string') target[key] = source[key];
    }
  }
  return elements;
}

// A deep copy, plug states included. (normalizeElements always builds fresh objects.)
export function cloneElements(elements) {
  return normalizeElements(elements);
}

// Tidies one field for the prompt: line endings become \n, blank lines at the start and
// whitespace at the end go. Multi-line text keeps its indentation so code and nested lists
// survive; single-line text is trimmed on both sides.
export function tidy(text) {
  const tidied = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .trimEnd();
  return tidied.includes('\n') ? tidied : tidied.trimStart();
}

// True when a field (or, for Rules, any of its sub-fields) has text in it.
export function hasContent(def, element) {
  return textKeys(def).some((key) => tidy(element?.[key]) !== '');
}

// The prompt that gets sent: each plugged, non-empty element under a "## Label" heading,
// in the fixed order, separated by a blank line. Rules becomes "Do: …", "Don't: …" and
// "Fallback: …" lines, leaving out empty ones; a multi-line rule starts on the line after
// its label so a list typed into it stays a list.
export function assemble(elements) {
  const state = normalizeElements(elements);
  const sections = [];
  for (const def of ELEMENTS) {
    const element = state[def.id];
    if (!element.plugged) continue;
    const body = def.parts ? rulesBody(def, element) : tidy(element.text);
    if (body) sections.push(`## ${def.label}\n${body}`);
  }
  return sections.join('\n\n');
}

function rulesBody(def, element) {
  return def.parts
    .map((part) => {
      const text = tidy(element[part.id]);
      if (!text) return '';
      return text.includes('\n') ? `${part.label}:\n${text}` : `${part.label}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

// How two runs' elements differ, as element ids in the fixed order:
//   onlyBefore / onlyAfter  plugged in one run and not the other
//   textChanged             plugged in both, with different text (whitespace at the edges ignored)
// Text edits to an element unplugged in both runs are left out: neither run sent it.
export function compareElements(before, after) {
  const a = normalizeElements(before);
  const b = normalizeElements(after);
  const result = { onlyBefore: [], onlyAfter: [], textChanged: [] };
  for (const def of ELEMENTS) {
    const x = a[def.id];
    const y = b[def.id];
    if (x.plugged && !y.plugged) result.onlyBefore.push(def.id);
    else if (!x.plugged && y.plugged) result.onlyAfter.push(def.id);
    else if (x.plugged && textKeys(def).some((key) => tidy(x[key]) !== tidy(y[key]))) {
      result.textChanged.push(def.id);
    }
  }
  return result;
}

// Rough token count: characters ÷ CHARS_PER_TOKEN, rounded up.
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}
