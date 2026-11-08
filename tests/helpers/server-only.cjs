/*
 * The "server-only" package throws when imported (its default export) and
 * resolves to an empty module only under the "react-server" export
 * condition, which Next.js uses for server code (route handlers, server
 * components). node:test does not use that condition, so tests that load
 * server-only modules (lib/student-qr-token.ts and everything importing it)
 * map it the same way Next.js does: to the package's own empty.js.
 *
 * Require this BEFORE any such module. tests/student-qr/student-qr-token.test.cjs
 * checks that without this mapping the import really throws.
 */

"use strict";

const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..", "..");
const entry = require.resolve("server-only", { paths: [root] });
const empty = path.join(path.dirname(entry), "empty.js");

const mod = new Module(entry);
mod.filename = entry;
mod.loaded = true;
mod.exports = require(empty);
require.cache[entry] = mod;
