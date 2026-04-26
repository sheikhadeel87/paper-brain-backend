/**
 * Load `.env` before any other app modules read `process.env` (JWT, Mongo, etc.).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.join(__dirname, '..', '..', '.env');
const backendEnvPath = path.join(__dirname, '..', '.env');
const envPath = fs.existsSync(rootEnvPath) ? rootEnvPath : backendEnvPath;

dotenv.config({
  path: envPath,
  // Prefer file over stale shell exports in local dev.
  override: true,
  quiet: true,
});
