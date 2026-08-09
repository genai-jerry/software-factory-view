import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL ?? "postgres://console:console@localhost:5432/console";
runMigrations(url)
  .then((applied) => {
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
