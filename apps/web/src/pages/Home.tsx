import { type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.js";
import { AppCredentialsForm } from "../components/AppCredentialsForm.js";
import type { Me, SetupStatus } from "../types.js";
import { ConnectEstate } from "./Onboarding.js";

/**
 * Front door for a SaaS factory. First run: paste the GitHub App credentials
 * so sign-in can work. After that, new users sign in with GitHub and connect
 * an organisation. The App owner can still rotate those credentials in Settings.
 * Returning users with an organisation never see this; `/` is mission control.
 */
export function HomePage({
  me,
  setup,
  onConnected,
}: {
  me: Me | null;
  setup: SetupStatus | undefined;
  onConnected: () => void;
}) {
  const qc = useQueryClient();
  const signedIn = Boolean(me);
  const needsApp = Boolean(setup && !setup.configured && setup.canEditApp);
  const current: StationId = needsApp ? "app" : !signedIn ? "signin" : "org";
  const n = (step: number) => String(needsApp ? step : step - 1).padStart(2, "0");

  return (
    <div className="home">
      <header className="home-bar">
        <span className="home-mark">Compass</span>
        {me ? (
          <span className="home-who">
            {me.avatarUrl && <img src={me.avatarUrl} alt="" width={22} height={22} />}
            @{me.login}
            <button
              onClick={() => {
                void api.post("/api/auth/logout").then(() => window.location.reload());
              }}
            >
              Sign out
            </button>
          </span>
        ) : (
          <span className="muted">GitHub is your account</span>
        )}
      </header>

      <div className="home-body">
        <section className="home-lede">
          <p className="home-kicker">Getting started</p>
          <h1>
            {needsApp
              ? "Register the GitHub App, then sign in."
              : signedIn
                ? "Bring your organisations in."
                : "Sign in, then bring the repos."}
          </h1>
          <p className="muted">
            {needsApp ? (
              <>
                Sign-in uses one GitHub App for this Console. Paste its App ID, private key, and OAuth credentials from
                GitHub — or create one from a manifest. After it is saved, you sign in with GitHub and pick repositories.
              </>
            ) : signedIn ? (
              <>
                Tick the repositories the factory should watch, then confirm the App on GitHub. GitHub will return you
                here to connect those repositories and continue factory enablement. The first person to connect an
                organisation owns it.
              </>
            ) : (
              <>
                There is no separate registration. Sign in with GitHub, connect an organisation, and pick the
                repositories the factory should watch. Every action after that is a GitHub operation under your own
                identity.
              </>
            )}
          </p>
        </section>

        {setup?.appReset && (setup.source === "database" || Boolean(setup.credentialError)) && (
          <ResetAppCredentials onReset={() => void qc.invalidateQueries({ queryKey: ["setup"] })} />
        )}

        <ol className="ticket">
          {needsApp && setup && (
            <Station
              n={n(1)}
              id="app"
              title="GitHub App"
              current={current}
              done={false}
              status="your move"
            >
              <AppStation setup={setup} onSaved={() => void qc.invalidateQueries({ queryKey: ["setup"] })} />
            </Station>
          )}
          <Station
            n={n(2)}
            id="signin"
            title="Sign in with GitHub"
            current={current}
            done={signedIn}
            status={signedIn ? `@${me!.login}` : needsApp ? "after the App" : "your move"}
          >
            {current === "signin" && <SignInStation setup={setup} />}
          </Station>
          <Station
            n={n(3)}
            id="org"
            title="Organisation and repositories"
            current={current}
            done={false}
            status={signedIn ? "pick repos" : "after sign-in"}
          >
            {current === "org" && me && <ConnectEstate onConnected={onConnected} title="Connect an organisation" />}
          </Station>
          <Station
            n={n(4)}
            id="enable"
            title="Enable the factory"
            current={current}
            done={false}
            status="labels, secrets, OpenSpec"
          />
        </ol>
      </div>
    </div>
  );
}

type StationId = "app" | "signin" | "org" | "enable";

function Station({
  n,
  id,
  title,
  current,
  done,
  status,
  children,
}: {
  n: string;
  id: StationId;
  title: string;
  current: StationId;
  done: boolean;
  status: string;
  children?: ReactNode;
}) {
  const state = done ? "done" : current === id ? "current" : "wait";
  return (
    <li className={`ticket-row ${state}`}>
      <div className="ticket-head">
        <span className="ticket-n">{n}</span>
        <span className="ticket-title">{title}</span>
        <span className="ticket-status">
          {done ? "done" : state === "current" ? "now" : "wait"} · {status}
        </span>
      </div>
      {state === "current" && children && <div className="ticket-body">{children}</div>}
    </li>
  );
}

function ResetAppCredentials({ onReset }: { onReset: () => void }) {
  const reset = useMutation({
    mutationFn: () => api.del<{ ok: boolean }>("/api/setup/credentials"),
    onSuccess: onReset,
  });
  return (
    <div className="banner stale" style={{ marginTop: "1rem" }}>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <code>APP_RESET</code> is on. This removes the stored GitHub App so you can paste the credentials again. Turn the
        flag off when you are done.
      </p>
      <button
        className="danger"
        disabled={reset.isPending}
        onClick={() => {
          if (!window.confirm("Remove the stored GitHub App credentials? Sign-in will stop until you save them again.")) {
            return;
          }
          reset.mutate();
        }}
      >
        {reset.isPending ? "Resetting…" : "Reset GitHub App credentials"}
      </button>
      {reset.isError && (
        <div className="banner error" style={{ marginTop: "0.5rem" }}>
          {(reset.error as ApiError).message}
        </div>
      )}
    </div>
  );
}

function SignInStation({ setup }: { setup: SetupStatus | undefined }) {
  return (
    <div>
      <p className="muted">
        This creates your Console user from your GitHub identity. After you return, your repositories are listed so you
        can pick where to install the factory.
      </p>
      {setup?.configured && (
        <details className="banner-tech">
          <summary>If GitHub shows a 404</summary>
          <p className="muted">
            The factory App may still be private or its Callback URL is not exactly{" "}
            <code>{setup.publicOrigin}/auth/github/callback</code>. Callback URL is under Identifying and authorizing
            users. To let other GitHub users sign in: left sidebar → Advanced → Danger zone → Make public.
          </p>
        </details>
      )}
      {setup && !setup.configured && !setup.devLogin ? (
        <p className="muted">Sign-in is not available yet. Register the GitHub App in the step above.</p>
      ) : (
        <p>
          <a href="/auth/github/login">
            <button className="primary">Sign in with GitHub</button>
          </a>
        </p>
      )}
      {setup?.devLogin && (
        <p className="muted">
          Dev mode: <a href="/auth/dev-login">sign in without GitHub</a>
        </p>
      )}
    </div>
  );
}

function AppStation({ setup, onSaved }: { setup: SetupStatus; onSaved: () => void }) {
  if (!setup.hasMasterKey) {
    return (
      <div className="banner error">
        <code>CONSOLE_MASTER_KEY</code> is not set, so credentials cannot be stored. Run <code>./scripts/setup.sh</code>{" "}
        and restart.
      </div>
    );
  }
  return (
    <div>
      <p className="muted">
        Or create one on GitHub from a manifest: <a href="/setup/github-app">Create the GitHub App</a>.
      </p>
      <AppCredentialsForm status={setup} onSaved={onSaved} />
    </div>
  );
}
