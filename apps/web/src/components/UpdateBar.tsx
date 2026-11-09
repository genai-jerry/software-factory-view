import { useEffect, useState } from "react";

/**
 * "Compass has been updated": a page left open across a deploy keeps running
 * the old code — in Shape that meant no card under Claude's proposal, so a
 * typed "yes" did nothing. Every few minutes, and when the tab comes back, the
 * live index.html is read and its app script compared with the one this page
 * loaded. A different one means a newer Compass is out.
 */

const SCRIPT = /\/assets\/index-[\w-]+\.js/;
const EVERY_MS = 5 * 60_000;

export function loadedScript(doc: Document = document): string | null {
  const src = [...doc.querySelectorAll<HTMLScriptElement>("script[src]")].map((s) => s.getAttribute("src") ?? "").find((s) => SCRIPT.test(s));
  return src ? (SCRIPT.exec(src)?.[0] ?? null) : null;
}

const liveIndex = () => fetch("/", { cache: "no-store" }).then((r) => r.text());

export function UpdateBar({ fetchIndex = liveIndex }: { fetchIndex?: () => Promise<string> }) {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const mine = loadedScript();
    if (!mine) return; // the dev server: nothing to compare
    let stopped = false;
    const check = async () => {
      try {
        const live = SCRIPT.exec(await fetchIndex())?.[0];
        if (!stopped && live && live !== mine) setStale(true);
      } catch {
        /* offline for a moment: try again later */
      }
    };
    const timer = setInterval(check, EVERY_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    void check();
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [fetchIndex]);
  if (!stale) return null;
  return (
    <div className="banner update-bar" role="status">
      Compass has been updated. Reload to get the latest — this page is running the earlier version.{" "}
      <button type="button" className="primary" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
