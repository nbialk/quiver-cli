import { afterEach, expect, it, vi } from "vitest";
import { spinner } from "@clack/prompts";
import { progress } from "../src/ui/prompts.js";

vi.mock("@clack/prompts", () => ({ spinner: vi.fn() }));

const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
  else Reflect.deleteProperty(process.stdout, "isTTY");
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("starts, updates, clears and restarts the terminal spinner", async () => {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const pending = { start: vi.fn(), message: vi.fn(), clear: vi.fn(), stop: vi.fn(), cancel: vi.fn(), error: vi.fn(), isCancelled: false };
  vi.mocked(spinner).mockReturnValue(pending);
  const display = await progress(true);
  display.update("First");
  display.update("Second");
  expect(pending.start).toHaveBeenCalledExactlyOnceWith("First");
  expect(pending.message).toHaveBeenCalledWith("Second");
  display.clear();
  display.clear();
  expect(pending.clear).toHaveBeenCalledTimes(1);
  display.update("Third");
  expect(pending.start).toHaveBeenCalledTimes(2);
  display.clear();
});

it("uses plain progress lines without a spinner for pipes", async () => {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const display = await progress(true);
  display.update("Checking skill:demo");
  display.clear();
  expect(log).toHaveBeenCalledExactlyOnceWith("  Checking skill:demo");
  expect(spinner).not.toHaveBeenCalled();
});

it("does not create a spinner or print progress for JSON", async () => {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const display = await progress(false);
  display.update("Checking");
  display.clear();
  expect(log).not.toHaveBeenCalled();
  expect(spinner).not.toHaveBeenCalled();
});
