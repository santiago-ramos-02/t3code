import { useEffect, useState } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import {
  formatPromptCacheCountdown,
  formatPromptCacheDuration,
  type PromptCacheMiss,
  type PromptCacheSnapshot,
  promptCacheState,
} from "~/lib/promptCache";

function missCause(miss: PromptCacheMiss) {
  switch (miss.kind) {
    case "expired":
      return `it had expired after ${formatPromptCacheDuration(miss.idleSeconds)} without a request`;
    case "model":
      return "the model changed";
    case "context":
      return "the start of the conversation changed, such as its instructions or tools";
  }
}

/**
 * The context window popover's prompt cache: what the last turn reused, how long the cache
 * lives on, and why the turn rebuilt it when it did. It ticks only while the popover is open,
 * since the popover mounts it then.
 */
export function PromptCacheSection(props: {
  readonly cache: PromptCacheSnapshot;
  /** What the next request sends, which it re-reads in full once the cache has expired. */
  readonly contextTokens: number;
  readonly canCompact: boolean;
}) {
  const { cache } = props;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ticking = !cache.working && cache.ttlSeconds !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ticking]);
  const state = promptCacheState(cache, nowMs);

  return (
    <div className="flex flex-col gap-1.5 border-t pt-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Prompt cache</div>
        <div className="text-secondary-label text-2xs tabular-nums">
          {Math.round(cache.hitRate * 100)}% reused
        </div>
      </div>
      <CacheRow label="Read from cache" tokens={cache.readTokens} />
      {cache.writtenTokens !== null ? (
        <CacheRow label="Written to cache" tokens={cache.writtenTokens} />
      ) : null}
      <CacheRow label="Not cached" tokens={cache.uncachedTokens} />
      {state.kind === "warm" ? (
        <p className="text-pretty text-secondary-label text-2xs">Warm while the agent works.</p>
      ) : state.kind === "expiresIn" ? (
        <p className="text-pretty text-secondary-label text-2xs">
          Expires in{" "}
          <span className="font-medium tabular-nums">
            {formatPromptCacheCountdown(state.seconds)}
          </span>{" "}
          unless you send a message.
        </p>
      ) : state.kind === "expired" ? (
        <p className="text-pretty text-secondary-label text-2xs">
          Expired {formatPromptCacheDuration(state.secondsAgo)} ago. The next message sends about{" "}
          {formatContextWindowTokens(props.contextTokens)} tokens without it
          {props.canCompact ? "; compacting first sends less." : "."}
        </p>
      ) : null}
      {cache.miss !== null ? (
        <p className="text-pretty text-secondary-label text-2xs">
          The last turn rebuilt the cache: {missCause(cache.miss)}.
        </p>
      ) : null}
    </div>
  );
}

function CacheRow(props: { readonly label: string; readonly tokens: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-2xs leading-4">
      <span className="text-secondary-label">{props.label}</span>
      <span className="font-medium tabular-nums text-secondary-label">
        {formatContextWindowTokens(props.tokens)}
      </span>
    </div>
  );
}
