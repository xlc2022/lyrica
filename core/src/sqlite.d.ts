// better-sqlite3-multiple-ciphers ships types its package exports hide; its API matches better-sqlite3.
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export = Database;
}
