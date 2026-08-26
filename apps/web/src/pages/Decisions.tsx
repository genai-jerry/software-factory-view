import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import type { Decision } from "../types.js";

export function DecisionsPage() {
  const [q, setQ] = useState("");
  const decisions = useQuery({
    queryKey: ["decisions", q],
    queryFn: () => api.get<{ decisions: Decision[] }>(`/api/decisions${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  });

  return (
    <div>
      <h1>Decision log</h1>
      <p className="muted">Every decision is also a structured comment on its epic — this is the index, GitHub is the record.</p>
      <div className="card">
        <label className="sr-only" htmlFor="decision-search">
          Search decisions
        </label>
        <input id="decision-search" placeholder="Search decisions…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {decisions.data?.decisions.map((d) => (
        <DecisionCard key={d.id} d={d} />
      ))}
      {decisions.data?.decisions.length === 0 && <p className="muted">No decisions recorded yet.</p>}
    </div>
  );
}

export function DecisionCard({ d }: { d: Decision }) {
  return (
    <div className="card" style={d.status === "superseded" ? { opacity: 0.55 } : undefined}>
      <h3 style={{ margin: 0 }}>{d.title}</h3>
      <p className="muted">
        {d.status === "superseded" && <span className="badge">superseded</span>} @{d.decidedBy} ·{" "}
        {new Date(d.createdAt).toLocaleDateString()}
      </p>
      {d.context && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{d.context}</p>}
      {d.options.length > 0 && (
        <ul>
          {d.options.map((o, i) => (
            <li key={i} className={o === d.chosen ? "" : "muted"}>
              {o === d.chosen ? <strong>✓ {o}</strong> : o}
            </li>
          ))}
        </ul>
      )}
      {d.chosen && d.options.length === 0 && <p><strong>Chosen:</strong> {d.chosen}</p>}
      {d.consequences && <p className="muted"><strong>Consequences:</strong> {d.consequences}</p>}
    </div>
  );
}
