// OpenAI keeps a prompt prefix for 30 minutes after its last write or reuse on GPT-5.6 and later,
// the only lifetime those models offer:
// https://developers.openai.com/api/docs/guides/prompt-caching
const OPENAI_CACHE_TTL_SECONDS = 1_800;
// The Claude Code CLI writes every request to Claude's 1 hour cache.
const CLAUDE_CODE_CACHE_TTL_SECONDS = 3_600;

/** Whether an OpenAI model id names GPT-5.6 or later, as in `gpt-6.1-sol` or `gpt-5.6-codex`. */
function isFixedLifetimeOpenAiModel(model: string) {
  const match = /(?:^|[/:])gpt-(\d+)(?:\.(\d+))?/i.exec(model);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 5 || (major === 5 && minor >= 6);
}

/**
 * How long OpenAI keeps the prompt cache for a model, for providers whose usage reports do not
 * say. Undefined for models without a fixed lifetime, which OpenAI keeps for 5 to 10 idle
 * minutes or longer.
 */
export function openAiCacheTtlSeconds(model: string) {
  return isFixedLifetimeOpenAiModel(model) ? OPENAI_CACHE_TTL_SECONDS : undefined;
}

/**
 * How long a Pi model's provider keeps the prompt cache, read from the Pi provider and model an
 * assistant message names: Claude through the Claude Code CLI bridge, or GPT-5.6 and later.
 */
export function piCacheTtlSeconds(provider: string, model: string) {
  if (provider === "claude-bridge") return CLAUDE_CODE_CACHE_TTL_SECONDS;
  return openAiCacheTtlSeconds(model);
}
