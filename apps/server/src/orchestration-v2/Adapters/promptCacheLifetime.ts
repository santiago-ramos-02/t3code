// OpenAI keeps a prompt prefix for 30 minutes after its last write or reuse on GPT-5.6 and later,
// the only lifetime those models offer:
// https://developers.openai.com/api/docs/guides/prompt-caching
const OPENAI_CACHE_TTL_SECONDS = 1_800;
// Claude writes to a 5 minute or a 1 hour cache.
const CLAUDE_SHORT_CACHE_TTL_SECONDS = 300;
const CLAUDE_LONG_CACHE_TTL_SECONDS = 3_600;

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
 * How long the cache a Pi model call wrote lives. Pi reports how much of a write went to Claude's
 * 1 hour cache (`cacheWrite1h`) when its provider says; otherwise only OpenAI's fixed lifetime is
 * known. Undefined when neither says, and for a reporting call that wrote nothing, whose cache
 * keeps the lifetime an earlier write gave it.
 */
export function piCallCacheTtlSeconds(
  usage: { readonly cacheWrite: number | undefined; readonly cacheWrite1h: number | undefined },
  model: string | undefined,
) {
  if (usage.cacheWrite1h !== undefined) {
    if ((usage.cacheWrite ?? 0) === 0) return undefined;
    return usage.cacheWrite1h > 0 ? CLAUDE_LONG_CACHE_TTL_SECONDS : CLAUDE_SHORT_CACHE_TTL_SECONDS;
  }
  return model === undefined ? undefined : openAiCacheTtlSeconds(model);
}
