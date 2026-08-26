import type { ReactNode } from "react";

export function ActionBar({ children, labelledBy }: { children: ReactNode; labelledBy?: string }) {
  return (
    <div className="action-bar" role="region" aria-label="Primary actions" aria-labelledby={labelledBy}>
      {children}
    </div>
  );
}
