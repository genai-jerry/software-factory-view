import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_MIN, PHONE_MAX, PHONE_QUERY, screenSizeOf, useIsPhone } from "./screens.js";

describe("screenSizeOf", () => {
  it("names the three sizes at their edges and the common test widths", () => {
    expect(screenSizeOf(360)).toBe("phone");
    expect(screenSizeOf(PHONE_MAX)).toBe("phone");
    expect(screenSizeOf(768)).toBe("tablet");
    expect(screenSizeOf(DESKTOP_MIN - 1)).toBe("tablet");
    expect(screenSizeOf(DESKTOP_MIN)).toBe("desktop");
    expect(screenSizeOf(1280)).toBe("desktop");
  });

  it("uses the phone query the stylesheet uses", () => {
    expect(PHONE_QUERY).toBe("(max-width: 767px)");
  });
});

describe("useIsPhone", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  function fakeMedia(initial: boolean) {
    const listeners = new Set<() => void>();
    const mq = {
      matches: initial,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
    return {
      set(next: boolean) {
        mq.matches = next;
        listeners.forEach((fn) => fn());
      },
      listeners,
    };
  }

  it("follows the screen as it crosses the phone width", () => {
    const media = fakeMedia(true);
    const { result, unmount } = renderHook(() => useIsPhone());
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("is false where the browser has no matchMedia", () => {
    // @ts-expect-error -- jsdom without matchMedia, as in a plain test
    window.matchMedia = undefined;
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(false);
  });
});
