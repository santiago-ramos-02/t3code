# CLIProxyAPI

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is a local proxy that
gives agents one endpoint for your subscription accounts, such as Claude and
ChatGPT, and for providers you pay by API key. T3 Code installs, runs, and
manages it from **Settings > CLIProxyAPI**, for the computer T3 Code is
connected to, so you do not need its own control panel. **Open** under
**Control panel** still opens it in your browser.

## Set it up

1. Choose **Install**. T3 Code downloads the release for the computer, checks it
   against the release's checksums, and starts it.
2. Under **Accounts**, choose **Add account**, pick a provider, and sign in
   in the browser that opens. If that browser is on another device and lands
   on an error page after signing in, paste the page's address back in T3 Code.
3. Turn on **Use in T3 Code**. A **CLIProxyAPI** provider appears: Claude Code
   running through the proxy, with every model it serves and your pools in the
   model picker. Your other providers are unchanged, and the accounts' limits
   show in [Usage](./usage.md).

**Start at login** keeps it running in the background. **Update** appears when
a newer release is out; the version it replaces is kept beside it.

## Failover pools

A pool is one model name that tries its models in order: when one account is
at its usage limit, the next model answers. Create one under **Failover pools**,
for example a light model first and a second one to fall back on, then pick the
pool in a CLIProxyAPI thread like any model. Saving a pool updates the
CLIProxyAPI provider's models.

## Accounts and providers

- **Accounts** shows each account's usage windows and when a limited one can
  serve again. Turn an account off to stop using it without signing it out, or
  choose **Retry now** to try a limited account before its time.
- **API-key providers** adds a provider you pay by key, such as OpenCode Go or
  OpenRouter, with the models you name.
- **Client keys** are the keys tools use to reach the proxy. T3 Code uses the
  first one.
- **Routing** decides how requests spread across accounts of the same
  provider, and **Full configuration** edits every setting CLIProxyAPI has.

A model the proxy does not know yet, such as a Claude model released after its
model list was last updated, fails in CLIProxyAPI threads until the proxy's
list includes it. Keep using it through the regular Claude provider meanwhile.
