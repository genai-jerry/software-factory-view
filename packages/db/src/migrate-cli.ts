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

  if ((err as NodeJS.ErrnoException)?.code === "ECONNREFUSED") {
    return [
      `Nothing is listening at ${where}.`,
      `Start the Console's Postgres with ./scripts/setup.sh, or set DATABASE_URL to`,
      `a Postgres you are already running.`,
    ].join("\n");
  }
  return undefined;
}

runMigrations(url)
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
