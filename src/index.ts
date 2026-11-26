import { createApp } from './app.js';
import { createPool } from './db.js';

const db = createPool();
const port = Number(process.env.PORT ?? 3000);

createApp(db).listen(port, () => {
  console.log(`ledger-lab API listening on http://localhost:${port}`);
});
