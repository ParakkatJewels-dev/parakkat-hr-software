import process from 'node:process';
import { handleDeveloperApiRequest } from '../../src/lib/developerApiGateway.js';

// Vercel Node function; the Vite client never imports this handler or its environment.
export default async function handler(request, response) {
  const result = await handleDeveloperApiRequest(request, { environment: process.env });
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  response.statusCode = result.status;
  response.end(JSON.stringify(result.body));
}
