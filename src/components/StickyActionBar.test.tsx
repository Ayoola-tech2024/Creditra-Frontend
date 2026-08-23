import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StickyActionBar } from "../components/StickyActionBar";

function renderBar(props?: Partial<Parameters<typeof StickyActionBar>[0]>) {
  return render(
    <MemoryRouter>
      <StickyActionBar hasLines={true} hasUtilized={true} {...props} />
    </MemoryRouter>,
  );
}

function setScrollY(value: number) {
  vi.spyOn(window, "scrollY", "get").mockReturnValue(value);
}

describe("StickyActionBar", () => {
  it("renders hidden on mount when scrolled near top", () => {
    setScrollY(0);
    renderBar();
    const bar = screen.getByRole("region", { name: /quick actions/i });
    expect(bar).not.toHaveClass("sticky-action-bar--visible");
    expect(bar.getAttribute("data-visible")).toBe("false");
  });

  it("renders visible on mount when page loads pre-scrolled", () => {
    setScrollY(500);
    renderBar();
    const bar = screen.getByRole("region", { name: /quick actions/i });
    expect(bar).toHaveClass("sticky-action-bar--visible");
  });

  it("shows the bar after scrolling past the threshold", async () => {
    setScrollY(0);
    renderBar();
    const bar = screen.getByRole("region", { name: /quick actions/i });
    expect(bar).not.toHaveClass("sticky-action-bar--visible");
    setScrollY(500);
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(bar).toHaveClass("sticky-action-bar--visible");
  });

  it("hides the bar after scrolling back above content", async () => {
    setScrollY(500);
    renderBar();
    const bar = screen.getByRole("region", { name: /quick actions/i });
    setScrollY(50);
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(bar).not.toHaveClass("sticky-action-bar--visible");
  });

  it("shows Draw Credit, Repay, and Credit Lines when applicable", async () => {
    setScrollY(500);
    renderBar({ hasLines: true, hasUtilized: true });
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByRole("button", { name: /draw credit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /repay credit/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /view all credit lines/i }),
    ).toBeInTheDocument();
  });

  it("hides Draw Credit when user has no lines", () => {
    setScrollY(500);
    renderBar({ hasLines: false, hasUtilized: true });
    expect(screen.queryByRole("button", { name: /draw credit/i })).toBeNull();
    expect(screen.getByRole("button", { name: /repay credit/i })).toBeInTheDocument();
  });

  it("hides Repay when user has no utilization", () => {
    setScrollY(500);
    renderBar({ hasLines: true, hasUtilized: false });
    expect(screen.queryByRole("button", { name: /repay credit/i })).toBeNull();
    expect(screen.getByRole("button", { name: /draw credit/i })).toBeInTheDocument();
  });

  it("adds the no-motion class when reduced motion is active", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    setScrollY(0);
    renderBar();
    const bar = screen.getByRole("region", { name: /quick actions/i });
    expect(bar).toHaveClass("sticky-action-bar--no-motion");
    vi.unstubAllGlobals();
  });
});
