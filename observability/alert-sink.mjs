/**
 * A notification receiver that prints what it is sent.
 *
 * Alertmanager's job is to deliver; this is something for it to deliver to.
 * Slack and PagerDuty both need an account and a credential this project does
 * not have, and "here is the Slack config I would have used" is not evidence
 * that anything fires. This closes the loop locally: rule -> Prometheus ->
 * Alertmanager -> grouped -> delivered -> printed.
 *
 * Zero dependencies and no build step: it is mounted read-only into a stock
 * node image. A service whose only job is to log must not have a supply chain.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 9099);

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    // Alertmanager only ever POSTs. Anything else is a health probe or a
    // mistake, and both deserve a definite answer rather than a hang.
    res.writeHead(405, { 'content-type': 'text/plain' }).end('POST /alerts\n');
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));

  req.on('end', () => {
    // Acknowledge first. Alertmanager retries on a non-2xx, and a slow or
    // throwing receiver turns one alert into a stream of duplicates — so the
    // response does not wait on anything that can fail.
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}\n');

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      console.log(JSON.stringify({ at: new Date().toISOString(), error: 'unparseable payload' }));
      return;
    }

    /*
     * One line per alert rather than one per group, so grepping the log for an
     * alertname finds it. The group metadata is repeated on each line: cheap,
     * and it keeps a line self-contained.
     */
    for (const alert of body.alerts ?? []) {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          status: body.status,
          receiver: body.receiver,
          group: body.groupLabels,
          alertname: alert.labels?.alertname,
          severity: alert.labels?.severity,
          state: alert.status,
          startsAt: alert.startsAt,
          value: alert.annotations?.summary,
          runbook: alert.annotations?.runbook,
        }),
      );
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: `alert sink on :${PORT}` }));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
