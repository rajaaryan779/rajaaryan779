import { createServer } from 'node:http';
import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const db = openDb(process.env.DB_PATH || 'chaseup.db');
const app = createApp({ db, secureCookie: process.env.NODE_ENV === 'production' });
createServer(app).listen(port, () => console.log(`ChaseUp running on http://localhost:${port}`));
