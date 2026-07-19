import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { DEFAULT_SETTINGS } from "../src/domain/defaults";
import type { LibraryItem, QueueItem } from "../src/domain/types";

vi.mock("../src/services/bridge", async () => {
  const { BrowserPreviewBridge } = await import("../src/fixtures/preview");
  return { getBridge: () => new BrowserPreviewBridge() };
});

describe("Sonic application shell", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders a usable local-first workspace in browser preview mode", async () => {
    const { container } = render(<App />);

    expect(await screen.findByRole("button", { name: /sonic session/i })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^ready$/i })).toBeInTheDocument();
    expect(screen.getAllByText(/audio signal/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/not analyzed in v0\.2/i)).toBeInTheDocument();
    expect(screen.getByText(/does not analyze the audio signal/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm metadata & add to queue/i })).toBeInTheDocument();
    expect(screen.queryByText(/^\d+% match confidence$/i)).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("keeps native update checks unavailable in the browser preview", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /^settings$/i }));

    expect(screen.getByRole("heading", { name: /desktop updates/i })).toBeInTheDocument();
    expect(screen.getByText(/update checks are only available in the installed app/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check now/i })).toBeDisabled();
  });

  it("accepts a source URL and opens it for review", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = await screen.findByRole("textbox", { name: /youtube links/i });
    await user.type(input, "https://www.youtube.com/watch?v=fixtureABCD");
    await user.click(screen.getByRole("button", { name: /add links/i }));

    expect(await screen.findByRole("heading", { name: /night shift.*abcd/i }, { timeout: 3_000 }))
      .toBeInTheDocument();
  });

  it("cancels a queued native job instead of offering an invalid remove action", async () => {
    const user = userEvent.setup();
    render(<App />);

    const cancel = await screen.findByRole("button", { name: /cancel velvet static/i });
    expect(screen.queryByRole("button", { name: /remove velvet static/i })).not.toBeInTheDocument();
    await user.click(cancel);

    expect(await screen.findByRole("button", { name: /retry velvet static/i })).toBeInTheDocument();
  });

  it("clears removable terminal jobs while retaining completed Beat Library history", async () => {
    const now = "2026-07-18T12:00:00.000Z";
    const completed: QueueItem = {
      id: "client-completed",
      nativeJobId: "job-completed",
      source: { kind: "localFile", path: "C:\\Music\\Archive.wav" },
      metadata: { bpm: "128", key: "C minor", detuneCents: "" },
      presetId: "wav44100S24",
      channelMode: "preserve",
      writeEmbeddedTags: true,
      templateId: "title-metadata",
      outputDirectory: "C:\\Exports",
      filenamePreview: "Archive.wav",
      outputPath: "C:\\Exports\\Archive.wav",
      status: "completed",
      progress: { percent: 100, message: "Complete" },
      createdAt: now,
      updatedAt: now,
    };
    const cancelled: QueueItem = {
      ...completed,
      id: "client-cancelled",
      nativeJobId: "job-cancelled",
      filenamePreview: "Cancelled.wav",
      outputPath: undefined,
      status: "cancelled",
      progress: { message: "Cancelled" },
    };
    const history: LibraryItem = {
      id: "library-completed",
      jobId: "job-completed",
      title: "Archive",
      source: completed.source,
      sourceLabel: "Local file",
      outputPath: completed.outputPath ?? "",
      format: "wav",
      exportedAt: now,
      exists: true,
    };
    localStorage.setItem("sonic-v02-browser-preview", JSON.stringify({
      jobs: [completed, cancelled],
      library: [history],
      settings: DEFAULT_SETTINGS,
      paused: false,
    }));
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("In Library");
    await user.click(screen.getByRole("button", { name: /clear finished/i }));

    expect((await screen.findAllByText(/1 finished track is still linked to the Library/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Archive.wav").length).toBeGreaterThan(0);
    expect(screen.queryByText("Cancelled.wav")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
