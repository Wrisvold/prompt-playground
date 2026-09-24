import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffWords, textStats } from '../js/diff.js';

const same = (text) => ({ type: 'same', text });
const remove = (text) => ({ type: 'remove', text });
const add = (text) => ({ type: 'add', text });

// --- Required cases -------------------------------------------------------------------------

test('identical text is one unchanged segment', () => {
  assert.deepEqual(diffWords('The cat sat on the mat.', 'The cat sat on the mat.'), [same('The cat sat on the mat.')]);
  assert.deepEqual(diffWords('One two.\n\nThree four.', 'One two.\n\nThree four.'), [same('One two.\n\nThree four.')]);
  assert.deepEqual(diffWords('', ''), []);
});

test('full replacement: nothing in common is removed and added whole', () => {
  assert.deepEqual(diffWords('The cat sat.', 'A dog ran!'), [remove('The cat sat.'), same('\n\n'), add('A dog ran!')]);
  assert.deepEqual(diffWords('', 'Hello there.'), [add('Hello there.')]);
  assert.deepEqual(diffWords('Hello there.', ''), [remove('Hello there.')]);
});

test('insertion at the start', () => {
  assert.deepEqual(diffWords('cat sat on the mat', 'The cat sat on the mat'), [
    add('The'),
    same(' cat sat on the mat'),
  ]);
});

test('insertion in the middle', () => {
  assert.deepEqual(diffWords('The cat sat on the mat', 'The black cat sat on the mat'), [
    same('The'),
    add(' black'),
    same(' cat sat on the mat'),
  ]);
});

test('insertion at the end', () => {
  assert.deepEqual(diffWords('The cat sat', 'The cat sat down'), [same('The cat sat'), add(' down')]);
});

test('deletion, including at the start', () => {
  assert.deepEqual(diffWords('The black cat sat', 'The cat sat'), [same('The'), remove(' black'), same(' cat sat')]);
  assert.deepEqual(diffWords('Well, the cat sat', 'the cat sat'), [remove('Well,'), same(' the cat sat')]);
});

test('punctuation attached to a word is its own token', () => {
  // Adding a word before the full stop doesn't mark "sat." as changed.
  assert.deepEqual(diffWords('The cat sat.', 'The cat sat down.'), [same('The cat sat'), add(' down'), same('.')]);
  // Only the punctuation that changed is marked.
  assert.deepEqual(diffWords('Hello, world.', 'Hello world!'), [
    same('Hello'),
    remove(','),
    same(' world'),
    remove('.'),
    add('!'),
  ]);
});

test('apostrophes and hyphens keep a word whole', () => {
  assert.deepEqual(diffWords("I don't know.", 'I do not know.'), [
    same('I'),
    remove(" don't"),
    add(' do not'),
    same(' know.'),
  ]);
  assert.deepEqual(diffWords('a well-known fact', 'a known fact'), [
    same('a'),
    remove(' well-known'),
    add(' known'),
    same(' fact'),
  ]);
});

test('multi-paragraph input is diffed paragraph by paragraph', () => {
  assert.deepEqual(
    diffWords(
      'Intro line here.\n\nDetails follow in this part.',
      'Intro line here, now longer.\n\nDetails follow in this section.',
    ),
    [
      same('Intro line here'),
      add(', now longer'),
      same('.\n\nDetails follow in this'),
      remove(' part'),
      add(' section'),
      same('.'),
    ],
  );
});

test('a paragraph removed or added whole leaves its neighbours untouched', () => {
  assert.deepEqual(diffWords('One.\n\nTwo two.\n\nThree.', 'One.\n\nThree.'), [
    same('One.\n\n'),
    remove('Two two.'),
    same('\n\nThree.'),
  ]);
  assert.deepEqual(diffWords('Alpha.', 'Alpha.\n\nBeta.'), [same('Alpha.\n\n'), add('Beta.')]);
});

test('a moved paragraph shows as removed and added, without smearing into the other', () => {
  assert.deepEqual(diffWords('Cats purr softly.\n\nDogs bark loudly.', 'Dogs bark loudly.\n\nCats purr softly.'), [
    remove('Cats purr softly.'),
    same('\n\nDogs bark loudly.\n\n'),
    add('Cats purr softly.'),
  ]);
});

// --- Other behaviour ------------------------------------------------------------------------

test('whitespace-only differences are ignored, and paragraphs are separated by one blank line', () => {
  assert.deepEqual(diffWords('A b.\n\n\n\nC d.', 'A b.\n\nC d.'), [same('A b.\n\nC d.')]);
  assert.deepEqual(diffWords('A  b.\r\n\r\nC d.  ', 'A b.\n\nC d.'), [same('A b.\n\nC d.')]);
});

test('a short unchanged word stranded between two changes is folded into them', () => {
  assert.deepEqual(diffWords('Tom says I really like green apples', 'Tom says you never like red pears'), [
    same('Tom says'),
    remove(' I really like green apples'),
    add(' you never like red pears'),
  ]);
});

test('a shared stretch of several words between two changes is kept', () => {
  assert.deepEqual(diffWords('Try it with 1/3 + 1/3 next!', 'Now try 1/3 + 1/3 on your own.'), [
    remove('Try it with'),
    add(' Now try'),
    same(' 1/3 + 1/3'),
    remove(' next!'),
    add(' on your own.'),
  ]);
});

test('an insertion slides past a repeated word so it stays in one piece', () => {
  assert.deepEqual(
    diffWords('Keep the number the same, always.', 'Keep the number (the bottom one) the same, now.'),
    [same('Keep the number'), add(' (the bottom one)'), same(' the same,'), remove(' always'), add(' now'), same('.')],
  );
  assert.deepEqual(diffWords('the cat', 'the dog the cat'), [add('the dog'), same(' the cat')]);
});

test('a replaced list marker sits beside its replacement', () => {
  assert.deepEqual(diffWords('- Keep it\n- Add more', '1. Keep it\n2. Add more'), [
    remove('-'),
    add(' 1.'),
    same(' Keep it'),
    remove('\n-'),
    add(' 2.'),
    same(' Add more'),
  ]);
});

test('an unchanged word longer than the changes around it stays unchanged, with words kept apart', () => {
  assert.deepEqual(diffWords('red green blue', 'one green two'), [
    remove('red'),
    add(' one'),
    same(' green'),
    remove(' blue'),
    add(' two'),
  ]);
});

test('the segments always rebuild both texts (ignoring whitespace)', () => {
  const collapse = (text) => text.replace(/\s+/g, ' ').trim();
  const pairs = [
    ['The cat sat.', 'A dog ran!'],
    ['Well, the cat sat', 'the cat sat'],
    ['red green blue', 'one green two'],
    [
      'Here are three tips:\n\n- Drink water\n- Sleep well\n- Walk daily\n\nGood luck!',
      'Here are four tips:\n\n- Drink more water\n- Sleep well\n- Walk daily\n- Stretch\n\nThat is all. Good luck!',
    ],
    ['First.\n\nSecond one here.\n\nThird.', 'Zeroth.\n\nFirst.\n\nThird, changed.'],
    ['Keep the number the same, always.', 'Keep the number (the bottom one) the same, now.'],
    ['- Keep it\n- Add more', '1. Keep it\n2. Add more'],
    ['the cat sat on the mat and the dog', 'the dog sat on the cat and the mat'],
  ];
  for (const [a, b] of pairs) {
    const segments = diffWords(a, b);
    const rebuild = (kept) => segments.filter((segment) => segment.type === 'same' || segment.type === kept).map((segment) => segment.text).join('');
    assert.equal(collapse(rebuild('remove')), collapse(a), `older side of ${JSON.stringify(a)}`);
    assert.equal(collapse(rebuild('add')), collapse(b), `newer side of ${JSON.stringify(b)}`);
  }
});

// --- Stats ----------------------------------------------------------------------------------

test('textStats counts words, paragraphs and list items', () => {
  const text = [
    'Here are three tips:',
    '',
    '- Drink water',
    '- Sleep well',
    '* Walk daily',
    '',
    '1. First step',
    '2. Second step',
    '',
    'Well-known facts, e.g. 3.14, count once.',
  ].join('\n');
  assert.deepEqual(textStats(text), { words: 20, paragraphs: 4, listItems: 5 });
});

test('textStats: markers only count at the start of a line and before a space', () => {
  const text = '**Bold** is not a list.\n-5 degrees is not one either.\n3.14 is pi.\n  - an indented item is one';
  assert.equal(textStats(text).listItems, 1);
  assert.deepEqual(textStats(''), { words: 0, paragraphs: 0, listItems: 0 });
});
