import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ELEMENTS,
  assemble,
  cloneElements,
  compareElements,
  createEmptyElements,
  estimateTokens,
  hasContent,
  normalizeElements,
  tidy,
} from '../js/elements.js';

// Every element plugged in and filled.
function filled() {
  return {
    persona: { plugged: true, text: 'You are a patient maths tutor.' },
    task: { plugged: true, text: 'Explain how to add fractions.' },
    context: { plugged: true, text: 'The learner is ten years old.' },
    examples: { plugged: true, text: 'Q: 1/2 + 1/4?\nA: 3/4' },
    rules: {
      plugged: true,
      do: 'Use pizza slices.',
      dont: 'Use jargon.',
      fallback: 'Ask what they already know.',
    },
    criteria: { plugged: true, text: 'Under 150 words.' },
    steps: { plugged: true, text: '1. Show a picture.\n2. Add the slices.\n3. Check understanding.' },
  };
}

const PERSONA = '## Persona\nYou are a patient maths tutor.';
const TASK = '## Task\nExplain how to add fractions.';
const CONTEXT = '## Context\nThe learner is ten years old.';
const EXAMPLES = '## Examples\nQ: 1/2 + 1/4?\nA: 3/4';
const RULES = "## Rules\nDo: Use pizza slices.\nDon't: Use jargon.\nFallback: Ask what they already know.";
const CRITERIA = '## Criteria\nUnder 150 words.';
const STEPS = '## Steps\n1. Show a picture.\n2. Add the slices.\n3. Check understanding.';

const sections = (...parts) => parts.join('\n\n');

test('assembles every plugged element under its heading, in the fixed order', () => {
  assert.equal(
    assemble(filled()),
    sections(PERSONA, TASK, CONTEXT, EXAMPLES, RULES, CRITERIA, STEPS),
  );
});

test('leaves out unplugged elements and keeps the rest in order', () => {
  const elements = filled();
  elements.persona.plugged = false;
  elements.examples.plugged = false;
  elements.steps.plugged = false;
  assert.equal(assemble(elements), sections(TASK, CONTEXT, RULES, CRITERIA));
});

test('skips plugged elements that are empty or only whitespace', () => {
  const elements = filled();
  elements.persona.text = '';
  elements.context.text = '   \n\t  \n';
  elements.criteria.text = '\n';
  assert.equal(assemble(elements), sections(TASK, EXAMPLES, RULES, STEPS));
});

test('writes only the Rules lines that have text', () => {
  const elements = createEmptyElements();
  elements.rules.do = 'Use pizza slices.';
  elements.rules.fallback = 'Ask what they already know.';
  assert.equal(
    assemble(elements),
    '## Rules\nDo: Use pizza slices.\nFallback: Ask what they already know.',
  );

  elements.rules.do = '';
  elements.rules.fallback = '';
  elements.rules.dont = 'Use jargon.';
  assert.equal(assemble(elements), "## Rules\nDon't: Use jargon.");
});

test('skips Rules when all three sub-fields are empty, even though it is plugged', () => {
  const elements = filled();
  elements.rules = { plugged: true, do: '', dont: '  ', fallback: '\n' };
  assert.equal(assemble(elements), sections(PERSONA, TASK, CONTEXT, EXAMPLES, CRITERIA, STEPS));
});

test('skips Rules when unplugged, whatever its sub-fields hold', () => {
  const elements = filled();
  elements.rules.plugged = false;
  assert.equal(assemble(elements), sections(PERSONA, TASK, CONTEXT, EXAMPLES, CRITERIA, STEPS));
});

test('starts a multi-line rule on the line after its label', () => {
  const elements = createEmptyElements();
  elements.rules.do = '- Use pizza slices.\n- Draw a picture.';
  elements.rules.dont = 'Use jargon.';
  assert.equal(
    assemble(elements),
    "## Rules\nDo:\n- Use pizza slices.\n- Draw a picture.\nDon't: Use jargon.",
  );
});

test('returns an empty string when nothing is plugged or everything is empty', () => {
  const unplugged = filled();
  for (const def of ELEMENTS) unplugged[def.id].plugged = false;
  assert.equal(assemble(unplugged), '');
  assert.equal(assemble(createEmptyElements()), '');
});

test('keeps inner line breaks and indentation but tidies the edges', () => {
  const elements = createEmptyElements();
  elements.examples.text = '\n  \n    def add(a, b):\n        return a + b\n\n';
  elements.task.text = '   Explain the code.   ';
  assert.equal(
    assemble(elements),
    '## Task\nExplain the code.\n\n## Examples\n    def add(a, b):\n        return a + b',
  );
});

test('turns Windows line endings into \\n', () => {
  const elements = createEmptyElements();
  elements.steps.text = '1. Read.\r\n2. Answer.\r\n';
  assert.equal(assemble(elements), '## Steps\n1. Read.\n2. Answer.');
});

test('uses the fixed order whatever order the input keys arrive in', () => {
  const shuffled = Object.fromEntries(Object.entries(filled()).reverse());
  assert.equal(assemble(shuffled), assemble(filled()));
});

test('treats missing or malformed input as empty, plugged elements', () => {
  assert.equal(assemble(undefined), '');
  assert.equal(assemble(null), '');
  assert.equal(assemble('nonsense'), '');
  assert.equal(assemble({ task: { text: 'Hi' } }), '## Task\nHi');
  assert.equal(assemble({ task: { plugged: 'no', text: 42 } }), '');
});

test('createEmptyElements: all seven plugged in and empty, Rules with three sub-fields', () => {
  assert.deepEqual(createEmptyElements(), {
    persona: { plugged: true, text: '' },
    task: { plugged: true, text: '' },
    context: { plugged: true, text: '' },
    examples: { plugged: true, text: '' },
    rules: { plugged: true, do: '', dont: '', fallback: '' },
    criteria: { plugged: true, text: '' },
    steps: { plugged: true, text: '' },
  });
});

test('normalizeElements keeps valid values and drops unknown keys', () => {
  const normalized = normalizeElements({
    task: { plugged: false, text: 'Keep me', extra: 'drop me' },
    rules: { plugged: true, do: 'Be kind.', dont: 7 },
    mystery: { plugged: true, text: 'not an element' },
  });
  assert.deepEqual(normalized.task, { plugged: false, text: 'Keep me' });
  assert.deepEqual(normalized.rules, { plugged: true, do: 'Be kind.', dont: '', fallback: '' });
  assert.equal('mystery' in normalized, false);
});

test('cloneElements makes an independent deep copy, plug states included', () => {
  const original = filled();
  original.context.plugged = false;
  const copy = cloneElements(original);
  assert.deepEqual(copy, original);

  copy.rules.do = 'Changed';
  copy.task.plugged = false;
  assert.equal(original.rules.do, 'Use pizza slices.');
  assert.equal(original.task.plugged, true);
});

test('tidy trims single lines but keeps the indentation of multi-line text', () => {
  assert.equal(tidy('  hello  '), 'hello');
  assert.equal(tidy('\n\n  a\n    b\n'), '  a\n    b');
  assert.equal(tidy('  \n\t\n'), '');
  assert.equal(tidy(undefined), '');
});

test('hasContent looks at the text, or at any Rules sub-field', () => {
  const rules = ELEMENTS.find((def) => def.id === 'rules');
  const task = ELEMENTS.find((def) => def.id === 'task');
  assert.equal(hasContent(task, { plugged: true, text: '  \n ' }), false);
  assert.equal(hasContent(task, { plugged: false, text: 'x' }), true);
  assert.equal(hasContent(rules, { plugged: true, do: '', dont: '', fallback: '' }), false);
  assert.equal(hasContent(rules, { plugged: true, do: '', dont: 'No jargon', fallback: '' }), true);
});

test('compareElements lists plug differences and text changes, in the fixed order', () => {
  const before = filled();
  const after = filled();
  before.persona.plugged = false; // plugged only in the later run
  after.steps.plugged = false; // plugged only in the earlier run
  after.task.text = 'Explain how to subtract fractions.';
  after.rules.fallback = 'Say you are not sure.';
  after.context.text = '  The learner is ten years old.\n'; // whitespace at the edges only
  assert.deepEqual(compareElements(before, after), {
    onlyBefore: ['steps'],
    onlyAfter: ['persona'],
    textChanged: ['task', 'rules'],
  });
});

test('compareElements ignores text edits to an element unplugged in both runs', () => {
  const before = filled();
  const after = filled();
  before.examples.plugged = false;
  after.examples.plugged = false;
  after.examples.text = 'Something new';
  assert.deepEqual(compareElements(before, after), { onlyBefore: [], onlyAfter: [], textChanged: [] });
  assert.deepEqual(compareElements(filled(), filled()), { onlyBefore: [], onlyAfter: [], textChanged: [] });
});

test('estimateTokens is characters divided by four, rounded up', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('x'.repeat(400)), 100);
});

test('chips are unique two-letter codes in the order Pe Ta Co Ex Ru Cr St', () => {
  assert.deepEqual(
    ELEMENTS.map((def) => def.chip),
    ['Pe', 'Ta', 'Co', 'Ex', 'Ru', 'Cr', 'St'],
  );
});
