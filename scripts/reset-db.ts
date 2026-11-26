import { createPool, resetDatabase } from '../src/db.js';
import { setupPlatformAccounts } from '../src/flows.js';

const db = createPool();
await resetDatabase(db);
await setupPlatformAccounts(db, process.env.CURRENCY ?? 'USD');
console.log('Database reset; platform accounts created.');
await db.end();
