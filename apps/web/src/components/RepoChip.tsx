/**
 * The repo indicator: a deterministically-colored dot plus the repo's short
 * name, so rows from different repos are tellable apart at a glance in every
 * mixed list. Same repo → same hue, everywhere, both themes.
 */
export function RepoChip({ fullName, title }: { fullName: string; title?: string }) {
  return (
    <span className="repo-chip" title={title ?? fullName}>
      <span className="repo-dot" style={{ background: repoColor(fullName) }} />
      {fullName.split("/")[1] ?? fullName}
    </span>
  );
}

export function repoColor(fullName: string): string {
  let hash = 0;
  for (let i = 0; i < fullName.length; i++) hash = (hash * 31 + fullName.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}deg 55% 45%)`;
}
