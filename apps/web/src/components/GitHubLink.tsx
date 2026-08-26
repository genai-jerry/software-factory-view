export function GitHubLink({ href, children = "GitHub" }: { href: string; children?: string }) {
  return (
    <a className="github-link" href={href} target="_blank" rel="noreferrer" aria-label="Open on GitHub">
      {children}
    </a>
  );
}
