import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

import { completeOnboardingBeforeAction, OnboardingAgentCard } from "./WelcomeWizard";

const piProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
  displayName: "Pi",
  enabled: true,
  installed: true,
  version: "0.86.1",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-09-03T00:00:00.000Z",
  models: [
    {
      slug: "openrouter/anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "openai/gpt-5",
      name: "GPT-5",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

describe("first-run completion sequencing", () => {
  it("persists onboarding completion before opening provider settings", async () => {
    let resolveCompletion: () => void = () => {
      throw new Error("Completion resolver was not initialized.");
    };
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const events: string[] = [];
    const running = completeOnboardingBeforeAction({
      completeOnboarding: () => {
        events.push("completion-started");
        return completion;
      },
      action: () => {
        events.push("settings-opened");
      },
    });

    expect(events).toEqual(["completion-started"]);
    resolveCompletion();
    await running;
    expect(events).toEqual(["completion-started", "settings-opened"]);
  });

  it("does not navigate when onboarding completion fails", async () => {
    const failure = new Error("settings unavailable");
    const action = vi.fn();
    const running = completeOnboardingBeforeAction({
      completeOnboarding: () => Promise.reject(failure),
      action,
    });

    await expect(running).rejects.toBe(failure);
    expect(action).not.toHaveBeenCalled();
  });
});

describe("Pi onboarding card", () => {
  it("shows detected Pi readiness, version, and model count", async () => {
    await using _screen = await render(
      <OnboardingAgentCard
        driver="pi"
        setup="settings"
        provider={piProvider}
        terminalOpen={false}
        terminalAvailable
        onOpenTerminal={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await expect.element(page.getByText("Pi", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Ready to code. · v0.86.1 · 2 models")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Set up in Settings" }))
      .not.toBeInTheDocument();
  });

  it("routes unavailable Pi setup to provider settings without a terminal action", async () => {
    const onOpenSettings = vi.fn();
    const onOpenTerminal = vi.fn();
    await using _screen = await render(
      <OnboardingAgentCard
        driver="pi"
        setup="settings"
        provider={{
          ...piProvider,
          installed: false,
          version: null,
          status: "error",
          models: [],
          message: "Pi 0.86.1 or newer was not found on this environment.",
        }}
        terminalOpen={false}
        terminalAvailable
        onOpenTerminal={onOpenTerminal}
        onOpenSettings={onOpenSettings}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Set up in Settings" }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onOpenTerminal).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Install" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });
});
