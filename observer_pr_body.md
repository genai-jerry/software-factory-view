## Summary

After `claude -p` returns, the orchestrator no longer deletes the checkout immediately. If HEAD is a `factory/*` or `factory-console/*` branch that is ahead of origin, an observer:

1. Waits for leftover pytest/python under the workspace (best-effort)
2. Runs `.factory/profile.json` `commands.test` via `Popen` (waited, not fire-and-forget)
3. On green: `git push -u origin HEAD`, `gh pr create` with `Closes #N` if needed, issue comment with `<!-- factory-agent -->` (fasttrack also posts `<!-- factory-fast-track-done -->`)
4. On red: resumes Claude in the same checkout (max 2) with the test-log tail; never pushes red
5. Uses the shared `role_timeout_seconds` wall clock (default 45 min). Claude timeout still skips the observer.

Also streams run events (`{run_id}.events.jsonl`) and Claude/test stdout into the live transcript so the console can poll `GET /runs/{id}` for `{ts, kind, message}`.

Fixes the lighthouse `#214` pattern: one-shot Claude backgrounds pytest, process exits, `RoleRunner` `rmtree`s the workspace, no `PushEvent`.

## After merge

Redeploy the `factory-orchestrator` image. This is orchestrator code, not a factory-repo pin. `FACTORY_REF=v1` does not pick this up.

## Test plan

- [x] `orchestrator/tests/test_role_runner.py` — push-on-green, resume-on-red, skip-when-no-branch, null test command still pushes
- [x] `orchestrator/tests/test_live_log.py`, `test_graph.py`, `test_runs_api.py` — event log + streamed transcript
- [ ] Redeploy and re-run a lighthouse fasttrack that previously ended `no_op` with no GitHub trace
