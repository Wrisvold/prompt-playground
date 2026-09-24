// Values you may want to tune, kept in one place.

// The assembled-prompt panel estimates tokens as characters ÷ this number.
// Real tokenisers vary by model and language, which is why the panel says "approx."
export const CHARS_PER_TOKEN = 4;

// The three providers, in the order Settings lists them.
//
// Default model names change often. Checked against each provider's documentation on 2026-09-24:
//   gemini-3.8-flash  newest generally available Gemini Flash model; on Google's free tier
//   gpt-6-sol         smaller sibling of OpenAI's gpt-6-astra flagship; unlike astra it can
//                     answer with reasoning turned off, which this app asks for
//   claude-sonnet-5   current Claude Sonnet
//
// keyPage is where people create an API key. The how-to guide links to it.
export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    company: 'Google',
    defaultModel: 'gemini-3.8-flash',
    keyPage: { name: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
  },
  openai: {
    label: 'OpenAI',
    company: 'OpenAI',
    defaultModel: 'gpt-6-sol',
    keyPage: { name: 'the OpenAI Platform API keys page', url: 'https://platform.openai.com/api-keys' },
  },
  anthropic: {
    label: 'Anthropic',
    company: 'Anthropic',
    defaultModel: 'claude-sonnet-5',
    keyPage: { name: 'the Claude Console API keys page', url: 'https://platform.claude.com/settings/keys' },
  },
};

// Gemini first: it's the one with a free tier.
export const DEFAULT_PROVIDER = 'gemini';

// Max output tokens: the Settings default and the range the field accepts.
// (16 is the smallest value all three providers take.)
export const MAX_OUTPUT_TOKENS = { default: 1024, min: 16, max: 65536 };

// After a 429 (rate limited), wait this long before each retry. After the last retry the
// run stops and says so.
export const RATE_LIMIT_RETRY_DELAYS_MS = [2000, 5000, 10000];

// The one-word prompt Test connection sends.
export const TEST_PROMPT = 'Hello';

// Anthropic API version header. Checked 2026-09-24: still the only version.
export const ANTHROPIC_VERSION = '2023-06-01';
