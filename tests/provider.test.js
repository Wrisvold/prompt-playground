import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderError, runPrompt } from '../js/provider.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Swaps fetch for a queue of canned replies and returns the list of requests made.
// A reply is { status, body }, an Error to throw, or a function (url, init) => response.
function fakeFetch(...replies) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const next = replies.shift();
    if (next === undefined) throw new Error(`Unexpected request to ${url}`);
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    const { status = 200, body } = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return requests;
}

// A fresh model name per call keeps the per-model reasoning memory from leaking between tests.
let modelCount = 0;
function options(provider, overrides = {}) {
  modelCount += 1;
  return {
    provider,
    model: `${provider}-model-${modelCount}`,
    apiKey: 'test-key-123',
    prompt: 'Say hi',
    maxTokens: 1024,
    retryDelaysMs: [],
    ...overrides,
  };
}

async function rejectsWith(promise, kind) {
  let caught;
  await assert.rejects(promise, (error) => {
    caught = error;
    return error instanceof ProviderError && error.kind === kind;
  });
  return caught;
}

const gemini = (parts, finishReason = 'STOP') => ({
  body: { candidates: [{ content: { role: 'model', parts }, finishReason }] },
});
const openai = (text, extra = {}) => ({
  body: {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ],
    ...extra,
  },
});
const anthropic = (text, stop_reason = 'end_turn') => ({
  body: { content: [{ type: 'text', text }], stop_reason },
});

// --- Request shapes -------------------------------------------------------------------------

test('Gemini: key in a header (never the URL), lowest thinking level, thought parts skipped', async () => {
  const requests = fakeFetch(gemini([{ text: 'planning…', thought: true }, { text: 'Hello there' }]));
  const result = await runPrompt(options('gemini', { model: 'gemini-3.8-flash' }));

  const [request] = requests;
  assert.equal(request.method, 'POST');
  assert.equal(
    request.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
  );
  assert.equal(request.headers['x-goog-api-key'], 'test-key-123');
  assert.ok(!request.url.includes('test-key-123'));
  assert.deepEqual(request.body, {
    contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }],
    generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'low' } },
  });
  assert.equal(result.text, 'Hello there');
  assert.equal(result.truncated, false);
  assert.equal(result.reasoning, 'low');
  assert.equal(typeof result.durationMs, 'number');
});

test('OpenAI: Responses API, reasoning off, nothing stored, text from the message item', async () => {
  const requests = fakeFetch(openai('Hi from OpenAI'));
  const result = await runPrompt(options('openai', { model: 'gpt-6-sol', maxTokens: 500 }));

  const [request] = requests;
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.Authorization, 'Bearer test-key-123');
  assert.deepEqual(request.body, {
    model: 'gpt-6-sol',
    input: 'Say hi',
    max_output_tokens: 500,
    store: false,
    reasoning: { effort: 'none' },
  });
  assert.equal(result.text, 'Hi from OpenAI');
});

test('Anthropic: browser-access and version headers, thinking off, a single user message', async () => {
  const requests = fakeFetch(anthropic('Hi from Claude'));
  const result = await runPrompt(options('anthropic', { model: 'claude-sonnet-5' }));

  const [request] = requests;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'test-key-123');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.deepEqual(request.body, {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Say hi' }],
    thinking: { type: 'disabled' },
  });
  assert.equal(result.text, 'Hi from Claude');
});

test('the key is trimmed before it is sent', async () => {
  const requests = fakeFetch(anthropic('ok'));
  await runPrompt(options('anthropic', { apiKey: '  test-key-123\n' }));
  assert.equal(requests[0].headers['x-api-key'], 'test-key-123');
});

// --- Answers that stop early ----------------------------------------------------------------

test('an answer cut off at the token limit comes back flagged as truncated', async () => {
  fakeFetch(
    gemini([{ text: 'Part one' }], 'MAX_TOKENS'),
    openai('Part one', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    anthropic('Part one', 'max_tokens'),
  );
  for (const provider of ['gemini', 'openai', 'anthropic']) {
    const result = await runPrompt(options(provider));
    assert.equal(result.text, 'Part one', provider);
    assert.equal(result.truncated, true, provider);
  }
});

test('no text because the token limit ran out → out-of-tokens, with the fix', async () => {
  fakeFetch(gemini([], 'MAX_TOKENS'));
  const error = await rejectsWith(runPrompt(options('gemini')), 'out-of-tokens');
  assert.match(error.message, /Raise Max output tokens in Settings\./);
});

test("Gemini: an empty candidate list is the safety filter, not an empty response", async () => {
  fakeFetch({ body: { candidates: [], promptFeedback: { blockReason: 'SAFETY' } } }, gemini([], 'SAFETY'));
  const error = await rejectsWith(runPrompt(options('gemini')), 'blocked');
  assert.equal(error.summary, "Blocked by the provider's safety filter.");
  await rejectsWith(runPrompt(options('gemini')), 'blocked');
});

test('a reply with no text at all → empty', async () => {
  fakeFetch(anthropic('   '));
  await rejectsWith(runPrompt(options('anthropic')), 'empty');
});

// --- Errors ---------------------------------------------------------------------------------

test('a missing key fails before any request is made', async () => {
  const requests = fakeFetch();
  const error = await rejectsWith(runPrompt(options('openai', { apiKey: '   ' })), 'missing-key');
  assert.equal(error.message, 'No API key for OpenAI. Add one in Settings.');
  assert.equal(requests.length, 0);
});

test('401 and 403 → invalid-key, pointing at the key page', async () => {
  fakeFetch(
    { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'API key is invalid.' } } },
    { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Denied.' } } },
  );
  const error = await rejectsWith(runPrompt(options('anthropic')), 'invalid-key');
  assert.match(error.action, /the Claude Console API keys page/);
  await rejectsWith(runPrompt(options('gemini')), 'invalid-key');
});

test('Gemini: a 400 API_KEY_INVALID → invalid-key', async () => {
  fakeFetch({
    status: 400,
    body: {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'API key not valid. Please pass a valid API key.',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
      },
    },
  });
  await rejectsWith(runPrompt(options('gemini')), 'invalid-key');
});

test('404 → unknown-model, with the "may be retired" next step', async () => {
  fakeFetch({ status: 404, body: { error: { message: 'Not found' } } });
  const error = await rejectsWith(runPrompt(options('gemini', { model: 'gemini-0' })), 'unknown-model');
  assert.equal(
    error.message,
    `Gemini doesn't recognise the model "gemini-0". This model name may be retired. Change it in Settings.`,
  );
});

test('429 → waits with a countdown, retries, and succeeds', async () => {
  const requests = fakeFetch({ status: 429, body: {} }, { status: 429, body: {} }, anthropic('Finally'));
  const ticks = [];
  const result = await runPrompt(
    options('anthropic', { retryDelaysMs: [5, 5], onRetryWait: (tick) => ticks.push(tick) }),
  );
  assert.equal(result.text, 'Finally');
  assert.equal(requests.length, 3);
  assert.deepEqual(
    ticks.map(({ secondsLeft, retry, retries }) => [secondsLeft, retry, retries]),
    [
      [1, 1, 2],
      [0, 1, 2],
      [1, 2, 2],
      [0, 2, 2],
    ],
  );
});

test('429 on every try → stops after the last retry and says so', async () => {
  const requests = fakeFetch({ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} });
  const error = await rejectsWith(runPrompt(options('gemini', { retryDelaysMs: [5, 5] })), 'rate-limit');
  assert.equal(requests.length, 3);
  assert.equal(error.message, 'Gemini is still rate-limiting requests after 2 retries. Wait a minute, then run again.');
});

test('OpenAI: running out of credit is a 429 too, but it is not retried', async () => {
  const requests = fakeFetch({
    status: 429,
    body: { error: { message: 'You ran out.', type: 'insufficient_quota', code: 'credit_balance_exhausted' } },
  });
  await rejectsWith(runPrompt(options('openai', { retryDelaysMs: [5, 5] })), 'no-credit');
  assert.equal(requests.length, 1);
});

test('Anthropic: 402 billing_error → no-credit', async () => {
  fakeFetch({ status: 402, body: { type: 'error', error: { type: 'billing_error', message: 'No credit.' } } });
  await rejectsWith(runPrompt(options('anthropic')), 'no-credit');
});

test('a model that rejects the low-reasoning setting is resent with its default, and remembered', async () => {
  const model = 'claude-always-thinks';
  const requests = fakeFetch(
    {
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: "thinking.type: 'disabled' is not supported for this model." } },
    },
    anthropic('Thought about it'),
    anthropic('Again'),
  );
  const first = await runPrompt(options('anthropic', { model }));
  assert.equal(first.text, 'Thought about it');
  assert.equal(first.reasoning, 'default');
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  assert.equal('thinking' in requests[1].body, false);

  const second = await runPrompt(options('anthropic', { model }));
  assert.equal(second.reasoning, 'default');
  assert.equal(requests.length, 3);
  assert.equal('thinking' in requests[2].body, false);
});

test('OpenAI: a rejected reasoning effort falls back the same way', async () => {
  const requests = fakeFetch(
    {
      status: 400,
      body: { error: { message: "Unsupported value: 'none' is not supported with this model.", param: 'reasoning.effort' } },
    },
    openai('Answer'),
  );
  const result = await runPrompt(options('openai', { model: 'gpt-6-astra' }));
  assert.equal(result.reasoning, 'default');
  assert.equal('reasoning' in requests[1].body, false);
});

test('other 400s are not retried, and show the provider wording without the key', async () => {
  const requests = fakeFetch({
    status: 400,
    body: { error: { message: 'Something odd about test-key-123 in this request' } },
  });
  const error = await rejectsWith(runPrompt(options('openai')), 'bad-request');
  assert.equal(requests.length, 1);
  assert.equal(
    error.message,
    "OpenAI couldn't process the request: Something odd about [your key] in this request. Check Settings, then try again.",
  );
});

test('a Max output tokens value the model refuses gets its own message', async () => {
  fakeFetch({
    status: 400,
    body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 90000 > 64000, which is the maximum allowed' } },
  });
  const error = await rejectsWith(runPrompt(options('anthropic')), 'bad-request');
  assert.equal(error.message, 'Max output tokens is outside the range this model allows. Change it in Settings.');
});

test('5xx and 529 → server', async () => {
  fakeFetch({ status: 500, body: {} }, { status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } });
  await rejectsWith(runPrompt(options('openai')), 'server');
  await rejectsWith(runPrompt(options('anthropic')), 'server');
});

test('a success reply that is not JSON → server', async () => {
  fakeFetch({ status: 200, body: '<html>proxy error</html>' });
  await rejectsWith(runPrompt(options('gemini')), 'server');
});

test('a failed request → network', async () => {
  fakeFetch(new TypeError('Failed to fetch'));
  const error = await rejectsWith(runPrompt(options('anthropic')), 'network');
  assert.match(error.message, /^Couldn't reach Anthropic\./);
});

test('OpenAI: a failed request caused by a wrong key is reported as a wrong key', async () => {
  const requests = fakeFetch(new TypeError('Failed to fetch'), { status: 401, body: { error: {} } });
  await rejectsWith(runPrompt(options('openai')), 'invalid-key');
  assert.equal(requests[1].url, 'https://api.openai.com/v1/models');
  assert.equal(requests[1].headers.Authorization, 'Bearer test-key-123');
});

test('OpenAI: a failed request with a working key is still a network problem', async () => {
  fakeFetch(new TypeError('Failed to fetch'), { status: 200, body: { data: [] } });
  await rejectsWith(runPrompt(options('openai')), 'network');
});

test('cancelling while waiting for the reply → cancelled', async () => {
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  const controller = new AbortController();
  const pending = runPrompt(options('gemini', { signal: controller.signal }));
  controller.abort();
  const error = await rejectsWith(pending, 'cancelled');
  assert.equal(error.message, 'Cancelled.');
});

test('cancelling during a rate-limit wait → cancelled, without another request', async () => {
  const requests = fakeFetch({ status: 429, body: {} });
  const controller = new AbortController();
  const pending = runPrompt(
    options('openai', {
      signal: controller.signal,
      retryDelaysMs: [60000],
      onRetryWait: () => controller.abort(),
    }),
  );
  await rejectsWith(pending, 'cancelled');
  assert.equal(requests.length, 1);
});
