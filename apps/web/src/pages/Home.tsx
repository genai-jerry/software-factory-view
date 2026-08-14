import { type ReactNode } from "react";
import { api } from "../api.js";
import type { Me, SetupStatus } from "../types.js";
import { ConnectEstate } from "./Onboarding.js";

/**
 * Front door for a SaaS factory. The GitHub App is a platform credential
 * (environment secrets, editable later by the GitHub App owner in Settings). New
 * users sign in with GitHub and connect an organisation. Returning users with
 * an organisation never see this; `/` is mission control for them.
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
  const signedIn = Boolean(me);
  const current: StationId = !signedIn ? "signin" : "org";

  return (
    <div className="home">
      <header className="home-bar">
        <span className="home-mark">Factory Console</span>
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
          <h1>{signedIn ? "Bring your organisations in." : "Sign in, then bring the repos."}</h1>
          <p className="muted">
            {signedIn ? (
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

        <ol className="ticket">
          <Station
            n="01"
            id="signin"
            title="Sign in with GitHub"
            current={current}
            done={signedIn}
            status={signedIn ? `@${me!.login}` : "your move"}
          >
            {current === "signin" && <SignInStation setup={setup} />}
          </Station>
          <Station
            n="02"
            id="org"
            title="Organisation and repositories"
            current={current}
            done={false}
            status={signedIn ? "pick repos" : "after sign-in"}
          >
            {current === "org" && me && <ConnectEstate onConnected={onConnected} title="Connect an organisation" />}
          </Station>
          <Station
            n="03"
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

type StationId = "signin" | "org" | "enable";

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

function SignInStation({ setup }: { setup: SetupStatus | undefined }) {
  return (
    <div>
      <p className="muted">
        This creates your Console user from your GitHub identity. After you return, your repositories are listed so you
        can pick where to install the factory.
      </p>
      {setup?.configured && (
        <p className="muted">
          If GitHub shows a 404, the factory App is still private or its Callback URL is not exactly{" "}
          <code>{setup.publicOrigin}/auth/github/callback</code>. Callback URL is under Identifying and authorizing
          users. To let other GitHub users sign in: left sidebar → Advanced → Danger zone → Make public.
        </p>
      )}
      {setup && !setup.configured && !setup.devLogin ? (
        <p className="muted">Sign-in is not available yet. The factory is still being configured.</p>
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
