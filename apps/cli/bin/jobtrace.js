#!/usr/bin/env node
import { existsSync } from "node:fs";
import { main } from "../src/main.ts";

// Settings may be kept in a .env file in the current directory. Variables that
// are already set in the environment win.
if (existsSync(".env")) process.loadEnvFile(".env");

process.exitCode = await main(process.argv.slice(2));
