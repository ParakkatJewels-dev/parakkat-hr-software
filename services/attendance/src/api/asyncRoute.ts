import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Express 4 does not forward rejected async handlers to its error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => { void handler(req, res, next).catch(next); };
}
