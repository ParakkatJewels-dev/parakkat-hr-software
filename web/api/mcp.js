import process from 'node:process';
import { handleMcpRequest } from '../src/lib/mcpGateway.js';

// Vercel Node function for AI assistants (MCP). The Vite client never imports this handler.
export default async function handler(request, response) {
  const result = await handleMcpRequest(request, { environment: process.env });
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  response.statusCode = result.status;
  response.end(result.body === null ? undefined : JSON.stringify(result.body));
}
