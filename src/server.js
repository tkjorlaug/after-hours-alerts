try { require('dotenv').config(); } catch { /* Render provides real env; dotenv optional for local */ }
const express = require('express');
const zoom = require('./zoom');

const app = express();
const rawSaver = (req, _res, buf) => { req.rawBody = buf; }; // needed for signature check

app.get('/healthz', (_req, res) => res.send('ok'));
app.post('/webhooks/zoom', express.json({ verify: rawSaver }), zoom.handleWebhook);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`after-hours-alerts listening on :${port}`));
