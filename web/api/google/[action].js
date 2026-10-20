import process from 'node:process';
import { handleGoogleRequest } from '../../src/lib/googleGateway.js';

// Vercel Node function for Work Ledger's Google Calendar connection. The Vite client never imports it.
export default async function handler(request, response) {
  const result = await handleGoogleRequest(request, { environment: process.env });
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  response.statusCode = result.status;
  response.end(result.body === null ? undefined : JSON.stringify(result.body));
}
