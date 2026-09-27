import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
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

function elementWithText(view: unknown, text: string) {
  return visitElements(view, (element) => {
    const children = element.props.children;
    return (
      children === text || (Array.isArray(children) && children.some((child) => child === text))
    );
  });
}

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
  it("shows detected Pi readiness, version, and model count", () => {
    const view = OnboardingAgentCard({
      driver: "pi",
      setup: "settings",
      provider: piProvider,
      terminalOpen: false,
      terminalAvailable: true,
      onOpenTerminal: vi.fn(),
      onOpenSettings: vi.fn(),
    });

    expect(elementWithText(view, "Pi")).not.toBeNull();
    expect(elementWithText(view, "Ready")).not.toBeNull();
    const detail = visitElements(
      view,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes("break-words"),
    );
    expect(detail?.props.children).toContain(" · v0.86.1 · 2 models");
    expect(elementWithText(view, "Set up in Settings")).toBeNull();
  });

  it("routes unavailable Pi setup to provider settings without a terminal action", () => {
    const onOpenSettings = vi.fn();
    const onOpenTerminal = vi.fn();
    const view = OnboardingAgentCard({
      driver: "pi",
      setup: "settings",
      provider: {
        ...piProvider,
        installed: false,
        version: null,
        status: "error",
        models: [],
        message: "Pi 0.86.1 or newer was not found on this environment.",
      },
      terminalOpen: false,
      terminalAvailable: true,
      onOpenTerminal,
      onOpenSettings,
    });

    const settingsAction = elementWithText(view, "Set up in Settings");
    expect(settingsAction).not.toBeNull();
    (settingsAction?.props.onClick as (() => void) | undefined)?.();

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onOpenTerminal).not.toHaveBeenCalled();
    expect(elementWithText(view, "Install")).toBeNull();
    expect(elementWithText(view, "Sign in")).toBeNull();
  });
});
