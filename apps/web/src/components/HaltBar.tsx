export function HaltBar({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: string | null;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="halt-bar" role="status">
      <div className="halt-bar-copy">
        <strong>{title}</strong>
        {detail ? <span className="halt-bar-detail">{detail}</span> : null}
      </div>
      <button type="button" className="halt-bar-action" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}
