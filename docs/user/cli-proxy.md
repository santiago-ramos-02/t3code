# CLIProxyAPI

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is a local proxy that
gives agents one endpoint for your subscription accounts, such as Claude and
ChatGPT, and for providers you pay by API key. T3 Code installs, runs, and
manages it from **Settings > CLIProxyAPI**, for the computer T3 Code is
connected to, so you do not need its own control panel. **Open its control
panel** in the **⋯** menu still opens it in your browser.

## Set it up

1. Choose **Install**. T3 Code downloads the release for the computer, checks it
   against the release's checksums, and starts it.
2. Under **Accounts and keys**, choose **Add**, then **Sign in to an account**,
   pick a provider, and sign in in the browser that opens. If that browser is on
   another device and lands on an error page after signing in, paste the page's
   address back in T3 Code. **Add a provider by API key** adds one you pay by
   key, such as OpenCode Go or OpenRouter, with the models you name.
3. Turn on **Use in T3 Code**. A **CLIProxyAPI** provider appears: Claude Code
   running through the proxy, with every model it serves and your failover
   models in the model picker. Your other providers are unchanged, and the
   accounts' limits show in [Usage](./usage.md).

The top row shows whether it is running. Its **⋯** menu restarts or stops it,
turns **Start when I sign in** on or off, and syncs new models to T3 Code.
**Update** appears when a newer release is out; the version it replaces is kept
beside it.

## Failover models

A failover model is one model name that tries its models in order: when one
account is at its usage limit, the next model answers. Create one under
**Failover models**, for example a light model first and a second one to fall
back on, then pick it in a CLIProxyAPI thread like any model. Saving one updates
the CLIProxyAPI provider's models. **Models it serves** lists every model the
proxy offers, by provider.

## Accounts and keys

Each account shows its usage windows. Turn an account off to stop using it
without signing it out. Its **⋯** menu signs it out, or, when it is at its limit,
tries it again before its time.

**Advanced** holds what you set once: how requests spread across accounts of
the same provider, the client keys other tools use to reach the proxy (T3 Code
uses the first), plugins, recent errors, and the full configuration.

A model the proxy does not know yet, such as a Claude model released after its
model list was last updated, fails in CLIProxyAPI threads until the proxy's
list includes it. Keep using it through the regular Claude provider meanwhile.
