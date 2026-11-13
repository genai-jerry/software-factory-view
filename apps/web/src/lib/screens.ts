import { useEffect, useState } from "react";

/*
 * The three screen sizes (epic #178, design D1): phone under 768px, tablet
 * 768px to 1023px, desktop 1024px and up. CSS cannot read these, so
 * src/styles.css repeats the two numbers in its media queries (the comment at
 * the top of that file); keep the two in step.
 */
export const PHONE_MAX = 767;
export const DESKTOP_MIN = 1024;

export const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN}px)`;

export type ScreenSize = "phone" | "tablet" | "desktop";

/** The screen size a viewport width falls in. */
export function screenSizeOf(width: number): ScreenSize {
  if (width <= PHONE_MAX) return "phone";
  if (width < DESKTOP_MIN) return "tablet";
  return "desktop";
}

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

/** True while the screen is phone-sized; follows rotation and window resizes. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => matches(PHONE_QUERY));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}
