import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL ?? "postgres://console:console@localhost:5432/console";

type PgError = { code?: string; message?: string };

/** host:port/database of a connection string, with the password stripped. */
function target(raw: string): { where: string; user: string; database: string } {
  try {
    const u = new URL(raw);
    return {
      where: `${u.hostname || "localhost"}:${u.port || "5432"}`,
      user: decodeURIComponent(u.username) || "console",
      database: u.pathname.replace(/^\//, "") || "console",
    };
  } catch {
    return { where: "the configured host", user: "console", database: "console" };
  }
}

/**
 * Turn a connection failure into something actionable. The common one by far:
 * DATABASE_URL points at a Postgres the developer already had running (the
 * Console's own container publishes DB_PORT, which setup.sh moves off 5432 when
 * that port is taken), so the role and database simply are not there.
 */
function diagnose(err: unknown, raw: string): string | undefined {
  const { code } = (err ?? {}) as PgError;
  const { where, user, database } = target(raw);

  const wrongServer = [
    `Connected to the Postgres at ${where}, but it is not the Console's database.`,
    `That is usually a Postgres you already had running locally, rather than the`,
    `one docker compose starts for the Console.`,
    ``,
    `Either point the Console at its own Postgres:`,
    `  ./scripts/stop.sh && ./scripts/setup.sh   # publishes it on a free port and records DB_PORT in .env`,
    ``,
    `or prepare the Postgres at ${where} by hand:`,
    `  createuser --createdb --pwprompt ${user}`,
    `  createdb -O ${user} ${database}`,
  ].join("\n");

  switch (code) {
    case "28000": // invalid_authorization_specification — no such role
      return `${wrongServer}\n\n(Postgres reported: role "${user}" does not exist.)`;
    case "3D000": // invalid_catalog_name — no such database
      return `${wrongServer}\n\n(Postgres reported: database "${database}" does not exist.)`;
    case "28P01": // invalid_password
      return [
        `Postgres at ${where} rejected the password for "${user}".`,
        `DB_PASSWORD in .env must match the password that database was created with.`,
        `If the volume was created with an older password, reset it with:`,
        `  ./scripts/stop.sh --volumes && ./scripts/setup.sh   # destroys the local database`,
      ].join("\n");
    default:
      break;
  }

  switch ((err as NodeJS.ErrnoException)?.code) {
    case "ECONNREFUSED":
      return [
        `Nothing is listening at ${where}.`,
        `Start the Console's Postgres with ./scripts/setup.sh, or set DATABASE_URL to`,
        `a Postgres you are already running.`,
      ].join("\n");
    case "ECONNRESET":
      // Retried already, so this is not a slow start: something accepts the
      // connection and then drops it. Docker's port proxy does exactly that
      // when the container behind it never comes up.
      return [
        `Something at ${where} accepts connections and then closes them, and it did`,
        `not settle. If that is the Console's container, Postgres inside it is not`,
        `running — check why:`,
        `  ./scripts/logs.sh postgres        (or: docker compose logs postgres)`,
        ``,
        `A volume left over from a different DB_PASSWORD is the usual cause; the`,
        `password is only applied when the volume is first created. Reset it with:`,
        `  ./scripts/stop.sh --volumes && ./scripts/setup.sh   # destroys the local database`,
      ].join("\n");
    default:
      return undefined;
  }
}

/**
 * Errors that mean "not ready yet" rather than "wrong". Docker publishes a port
 * as soon as the container starts, and its proxy accepts connections before
 * Postgres is listening behind it — the connection is then reset, which is why
 * a migration run immediately after `compose up` sees ECONNRESET rather than a
 * refusal. 57P03 is the same story from a Postgres that is still starting up.
 */
const TRANSIENT = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "57P03", // cannot_connect_now — the database system is starting up
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry while the far end is still coming up, then let the real error through. */
async function waitForDatabase<T>(run: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;
  let announced = false;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      const code = (err as PgError & NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT.has(code) || Date.now() >= deadline) throw err;
      if (!announced) {
        console.error(`waiting for Postgres at ${target(url).where} to accept connections…`);
        announced = true;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }
}

waitForDatabase(() => runMigrations(url))
  .then((applied) => {
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
    process.exit(0);
  })
  .catch((err) => {
    const hint = diagnose(err, url);
    if (hint) {
      console.error(hint);
      console.error("");
    }
    console.error(err);
    process.exit(1);
  });
