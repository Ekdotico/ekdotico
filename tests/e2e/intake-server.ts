// The stand-in for Praktico's feedback intake that the end-to-end application talks to (playwright.config.ts, webServer;
// FEEDBACK_INTAKE_TEST_ORIGIN). It is the double of the unit and integration tests behind a plain HTTP server, so the
// signature is verified the way docs/contracts/feedback-intake.md says and a bad one is a 401. It listens on the
// loopback address only, and nothing of it reaches the real host.
import { createServer } from 'node:http';
import { praktico } from '../fixtures/praktico-double.ts';

const port = Number(process.env.INTAKE_STAND_IN_PORT);
const secret = process.env.FEEDBACK_SECRET;
if (!Number.isInteger(port) || !secret)
  throw new Error('INTAKE_STAND_IN_PORT and FEEDBACK_SECRET are required.');

const double = praktico(secret);

createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const answer = await double.fetch(`http://127.0.0.1:${port}${request.url}`, {
    method: request.method,
    headers: request.headers as Record<string, string>,
    body: Buffer.concat(chunks),
  });
  response.writeHead(answer.status, { 'content-type': 'application/json' });
  response.end(await answer.text());
}).listen(port, '127.0.0.1');
