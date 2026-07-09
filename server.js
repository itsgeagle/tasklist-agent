import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './src/config.js';
import { openDb, reconcile } from './src/store.js';
import { makeRouter } from './src/routes.js';
import { startSchedules, runReply } from './src/cron.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(config.DB_PATH);
// Clear any locks/running-runs left behind by a crash before we start
// accepting traffic or scheduling new work.
reconcile(db);

const onCommentAgent = (id) => runReply(db, id);

const app = express();
app.use(express.json());
app.use(makeRouter(db, { onCommentAgent }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.PORT, config.HOST, () => {
  console.log(`tasklist listening on http://${config.HOST}:${config.PORT}`);
  startSchedules(db);
});
