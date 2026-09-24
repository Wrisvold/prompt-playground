// The step-by-step guide: its content first, then the code that shows it.
//
// To change the wording, edit GUIDE_STEPS. Each step is { title, body, illustration? }.
// The body is plain text with a little markup:
//   a blank line            starts a new paragraph
//   "- " at a line's start  makes a bulleted list (for every line of that paragraph)
//   **Settings**            shows a control's name in bold
//   [text](https://…)       a link that opens in a new tab
//   [text](#step-2)         a link to another step of this guide
// `illustration` names one of the drawings in ILLUSTRATIONS further down. They are built
// from the app's own styles, so they keep matching the real controls.
// The API key page names and links come from PROVIDERS in constants.js.

import { PROVIDERS } from './constants.js';
import { ELEMENTS } from './elements.js';

const { gemini, openai, anthropic } = PROVIDERS;

export const GUIDE_STEPS = [
  {
    title: 'What this is',
    body: `A playground for testing prompts. You build a prompt from seven parts, send it to an AI model with your own API key, and compare the results of different versions.

Nothing is stored on a server. Everything stays in this browser tab.`,
    illustration: 'overview',
  },
  {
    title: 'Get an API key',
    body: `An API key is a password that lets this app send prompts to a model on your behalf. It is separate from a ChatGPT, Gemini or Claude chat subscription, which does not include one.

Create a key on the provider's own site:

- Gemini: [${gemini.keyPage.name}](${gemini.keyPage.url}). Gemini has a free tier, so you can start without paying.
- OpenAI: [${openai.keyPage.name}](${openai.keyPage.url}).
- Anthropic: [${anthropic.keyPage.name}](${anthropic.keyPage.url}).

OpenAI and Anthropic charge for API use. New accounts may get a small free allowance, but after that a key only works once you add a payment method or buy credit.

Copy the key as soon as it appears. Some providers show it only once.`,
  },
  {
    title: 'Enter your key',
    body: `Open **Settings** (the gear at the top right), pick your provider, and paste the key into the key field. Then click **Test connection**.

If it works, you'll see "Connected" in green. If the key isn't accepted, copy it again from the provider's page and paste it in. If the model isn't recognised, its name may have changed: edit the model name in Settings.

The key is held only in this tab and is sent only to that provider. It disappears when you close the tab, so you'll paste it in again next time. No key yet? [Step 2](#step-2) shows where to get one.`,
    illustration: 'settings',
  },
  {
    title: 'Fill in the seven elements',
    body: `Each element holds one part of your prompt:

- **Persona**: who the model should be, such as a patient maths tutor.
- **Task**: what you want it to do.
- **Context**: background it needs, such as who the answer is for.
- **Examples**: a sample of the kind of answer you want.
- **Rules**: what to do (Do), what to avoid (Don't), and what to do when it's unsure (Fallback).
- **Criteria**: how to judge a good answer, such as its length or tone.
- **Steps**: the order to work in.

Only **Task** is really necessary to get started. You can leave the others empty.`,
    illustration: 'element',
  },
  {
    title: 'Plug and unplug',
    body: `Each element has a switch. Unplugging leaves the text in place but keeps it out of the prompt that gets sent.

This is how you test whether an element matters: run with it plugged in, unplug it, run again, and compare the two runs. The **Assembled prompt** panel always shows exactly what will be sent.`,
    illustration: 'plugs',
  },
  {
    title: 'Run',
    body: `Click **Run**, or press Ctrl+Enter (Cmd+Enter on a Mac). The output appears below the prompt, and every successful run is added to the run list at the side. On a narrow screen, open the list with the **Runs** button at the top.

The run list clears when you close the tab, so copy anything you want to keep.`,
    illustration: 'run',
  },
  {
    title: 'Compare two runs',
    body: `Tick two runs in the run list and click **Compare**. The comparison has three parts:

- **What changed in the setup**: the elements, model or settings that differ between the two runs.
- **The outputs side by side**, with the older run on the left.
- **The word diff**: both outputs merged into one text, with removed words struck through and added words underlined.

Two runs of the identical prompt still differ a little, so a small difference may be chance rather than the change you made.`,
    illustration: 'compare',
  },
];

// The step (numbered from 1) that the "no API key" error opens.
export const KEY_STEP = 3;

// ---------------------------------------------------------------------------
// Rendering

// Builds the guide inside an empty <dialog> and returns { open(stepNumber) }.
//   shortcut  the Run shortcut as the Run button shows it ("Ctrl Enter" or "⌘ Enter")
//   onClose   called whenever the guide closes, however it was closed
//   onStart   called after the last step's Start button closes the guide
export function createGuide(dialog, { shortcut = 'Ctrl Enter', onClose = () => {}, onStart = () => {} } = {}) {
  let current = 0;

  const stepLinks = GUIDE_STEPS.map((step, index) =>
    el(
      'button',
      { type: 'button', class: 'guide-step-link' },
      el('span', { class: 'guide-num', 'aria-hidden': 'true' }, String(index + 1)),
      el('span', {}, step.title),
    ),
  );
  const progress = el('p', { class: 'guide-progress' });
  const title = el('h3', { class: 'guide-title', id: 'guide-step-title', tabindex: '-1' });
  const body = el('div', { class: 'guide-body' });
  // Pictures of controls, not controls: hidden from screen readers (the text says the same)
  // and inert so nothing in them can be focused or clicked.
  const figure = el('div', { class: 'guide-figure', 'aria-hidden': 'true' });
  figure.inert = true;
  const back = el('button', { type: 'button', class: 'btn' }, 'Back');
  const next = el('button', { type: 'button', class: 'btn btn-primary' }, 'Next');
  const close = el('button', { type: 'button', class: 'btn' }, 'Close');

  dialog.setAttribute('aria-labelledby', 'guide-heading');
  dialog.replaceChildren(
    el('div', { class: 'guide-head' }, el('h2', { id: 'guide-heading' }, 'How to use Prompt Playground'), close),
    el(
      'div',
      { class: 'guide-layout' },
      el(
        'nav',
        { class: 'guide-nav', 'aria-label': 'Guide steps' },
        el('ol', { class: 'guide-steps' }, stepLinks.map((link) => el('li', {}, link))),
      ),
      el(
        'section',
        { class: 'guide-step', 'aria-labelledby': 'guide-step-title' },
        progress,
        title,
        body,
        figure,
        el('div', { class: 'guide-actions' }, back, next),
      ),
    ),
  );

  function show(index, { moveFocus = true } = {}) {
    current = Math.max(0, Math.min(GUIDE_STEPS.length - 1, index));
    const step = GUIDE_STEPS[current];
    progress.textContent = `Step ${current + 1} of ${GUIDE_STEPS.length}`;
    title.textContent = step.title;
    body.replaceChildren(...renderBody(step.body));
    const draw = ILLUSTRATIONS[step.illustration];
    figure.hidden = !draw;
    figure.replaceChildren(...(draw ? [draw({ shortcut })] : []));
    stepLinks.forEach((link, i) => {
      if (i === current) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    });
    back.disabled = current === 0;
    next.textContent = current === GUIDE_STEPS.length - 1 ? 'Start' : 'Next';
    // Screen readers start reading the new step from its title.
    if (moveFocus) title.focus();
  }

  // Where focus goes back to after closing: whatever had it when the guide opened.
  let returnTo = null;
  function restoreFocus() {
    const active = document.activeElement;
    if (returnTo?.isConnected && (!active || active === document.body || dialog.contains(active))) {
      returnTo.focus();
    }
  }

  stepLinks.forEach((link, index) => link.addEventListener('click', () => show(index)));
  back.addEventListener('click', () => show(current - 1));
  next.addEventListener('click', () => {
    if (current < GUIDE_STEPS.length - 1) {
      show(current + 1);
      return;
    }
    dialog.close();
    onClose();
    onStart();
  });
  close.addEventListener('click', () => {
    dialog.close();
    onClose();
    restoreFocus();
  });
  // Esc closes the dialog natively; the close event also covers any other way of closing it.
  dialog.addEventListener('cancel', () => onClose());
  dialog.addEventListener('close', () => {
    onClose();
    restoreFocus();
  });
  body.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-step]');
    if (!link) return;
    event.preventDefault();
    show(Number(link.dataset.step) - 1);
  });

  return {
    open(stepNumber = 1) {
      show(stepNumber - 1, { moveFocus: false });
      if (!dialog.open) {
        returnTo = document.activeElement;
        dialog.showModal();
      }
      title.focus();
    },
  };
}

// Paragraphs and bulleted lists, following the markup described at the top of this file.
function renderBody(text) {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim());
      if (lines.every((line) => line.startsWith('- '))) {
        return el('ul', {}, lines.map((line) => el('li', {}, inline(line.slice(2)))));
      }
      return el('p', {}, inline(lines.join(' ')));
    });
}

// **bold** and [text](target) within one line of text. Everything else stays plain text.
function inline(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(/\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)/g)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const [, bold, label, target] = match;
    if (bold !== undefined) {
      nodes.push(el('strong', {}, bold));
    } else if (target.startsWith('#step-')) {
      nodes.push(el('a', { href: target, 'data-step': target.slice('#step-'.length) }, label));
    } else {
      nodes.push(
        el(
          'a',
          { href: target, target: '_blank', rel: 'noopener noreferrer' },
          label,
          el('span', { class: 'sr-only' }, ' (opens in a new tab)'),
        ),
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// el('p', { class: 'x' }, 'text', child, …): the guide's own tiny DOM helper, so this file
// stands alone. Strings become text nodes.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  node.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return node;
}

// ---------------------------------------------------------------------------
// Illustrations: the real controls, drawn with the app's own classes.

const GEAR_ICON =
  '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
  '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="2.75 2.75"/>' +
  '<circle cx="10" cy="10" r="5.1" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
  '<circle cx="10" cy="10" r="1.9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

function icon(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup; // a fixed string from this file, never user text
  return template.content.firstChild;
}

const arrow = () => el('span', { class: 'illo-arrow' }, '→');
const chips = (plugged = () => true) =>
  el(
    'span',
    { class: 'chips' },
    ELEMENTS.map((def) => el('span', { class: plugged(def) ? 'chip is-on' : 'chip' }, def.chip)),
  );

function plug(plugged) {
  return el(
    'span',
    { class: 'plug', 'aria-checked': String(plugged) },
    el('span', { class: 'plug-track' }, el('span', { class: 'plug-knob' })),
    el('span', { class: 'plug-text' }, plugged ? 'Plugged' : 'Unplugged'),
  );
}

function elementCard(label, plugged, text) {
  return el(
    'div',
    { class: 'element', 'data-plugged': String(plugged) },
    el('div', { class: 'element-head' }, el('span', { class: 'element-title' }, label), plug(plugged)),
    el('div', { class: 'field illo-field' }, text),
  );
}

function runCard(number, seconds, plugged) {
  return el(
    'div',
    { class: 'run-item' },
    el(
      'span',
      { class: 'run-open' },
      el('span', { class: 'run-line' }, el('span', { class: 'run-number' }, `Run #${number}`), el('span', { class: 'run-meta' }, seconds)),
      el('span', { class: 'run-model' }, `${gemini.label} · ${gemini.defaultModel}`),
      chips(plugged),
    ),
    el('span', { class: 'run-pick' }, el('input', { type: 'checkbox', checked: true })),
  );
}

const ILLUSTRATIONS = {
  overview: () =>
    el(
      'div',
      { class: 'illo illo-flow' },
      el('div', { class: 'illo-stage' }, chips(), el('span', { class: 'illo-caption' }, 'Build a prompt')),
      arrow(),
      el('div', { class: 'illo-stage' }, el('span', { class: 'btn btn-primary btn-run' }, 'Run'), el('span', { class: 'illo-caption' }, 'Send it')),
      arrow(),
      el('div', { class: 'illo-stage' }, el('span', { class: 'btn btn-small' }, 'Compare'), el('span', { class: 'illo-caption' }, 'Compare versions')),
    ),

  settings: () =>
    el(
      'div',
      { class: 'illo illo-panel' },
      el('span', { class: 'btn btn-quiet' }, icon(GEAR_ICON), 'Settings'),
      el(
        'div',
        { class: 'segmented' },
        [gemini, openai, anthropic].map((provider, index) =>
          el('label', {}, el('input', { type: 'radio', name: 'guide-illustration', checked: index === 0 }), provider.label),
        ),
      ),
      el(
        'div',
        { class: 'setting' },
        el('span', { class: 'setting-label' }, `${gemini.label} API key`),
        el('span', { class: 'input illo-key' }, '••••••••••••••••••••••'),
      ),
      el('span', { class: 'btn' }, 'Test connection'),
      el('p', { class: 'test-result is-ok' }, `Connected. ${gemini.label} answered using ${gemini.defaultModel}.`),
    ),

  element: () => elementCard('Task', true, 'Explain how to add fractions to a ten-year-old.'),

  plugs: () =>
    el(
      'div',
      { class: 'illo illo-split' },
      el(
        'div',
        { class: 'illo-stack' },
        elementCard('Persona', true, 'You are a patient maths tutor.'),
        elementCard('Examples', false, 'Q: What is 1/2 + 1/4?'),
      ),
      el(
        'div',
        { class: 'illo-stack' },
        el('span', { class: 'illo-caption' }, 'Assembled prompt'),
        el('pre', { class: 'mono-block' }, '## Persona\nYou are a patient maths tutor.'),
      ),
    ),

  run: ({ shortcut }) =>
    el(
      'div',
      { class: 'run-bar illo-bar' },
      el('span', { class: 'btn btn-primary btn-run' }, 'Run ', el('kbd', { class: 'kbd' }, shortcut)),
      el('p', { class: 'run-status' }, 'Run #1 finished in 2.4 s.'),
      el('span', { class: 'btn btn-quiet run-setup' }, `${gemini.label} · ${gemini.defaultModel}`),
    ),

  compare: () =>
    el(
      'div',
      { class: 'illo illo-split' },
      el(
        'div',
        { class: 'illo-stack' },
        el('div', { class: 'runs-head' }, el('span', { class: 'illo-caption' }, 'Runs'), el('span', { class: 'btn btn-small' }, 'Compare')),
        runCard(2, '2.1 s', (def) => def.id !== 'persona'),
        runCard(1, '2.4 s', () => true),
      ),
      el(
        'div',
        { class: 'illo-stack' },
        el('span', { class: 'illo-caption' }, 'Word diff'),
        el('pre', { class: 'mono-block diff' }, 'So the answer is ', el('del', {}, '2/4'), ' ', el('ins', {}, '1/2'), '.'),
      ),
    ),
};
