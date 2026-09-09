import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "./migrate"

export type DB = BunSQLiteDatabase

/**
 * Open (and migrate) the master database. SQLite is the dev/test backend;
 * drizzle keeps the schema portable so a Postgres backend can be swapped in
 * (design §S5) without touching service code.
 */
export function openDatabase(path: string): DB {
  const sqlite = new Database(path)
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  sqlite.exec("PRAGMA foreign_keys = ON")
  migrate(sqlite)
  return drizzle(sqlite)
}
