import type { ReactNode } from "react";

export type BannerTone = "info" | "stale" | "error" | "success";

export function Banner({
  tone = "info",
  children,
  technical,
}: {
  tone?: BannerTone;
  children: ReactNode;
  technical?: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`}>
      <div>{children}</div>
      {technical ? (
        <details className="banner-tech">
          <summary>Technical details</summary>
          <div className="banner-tech-body">{technical}</div>
        </details>
      ) : null}
    </div>
  );
}
