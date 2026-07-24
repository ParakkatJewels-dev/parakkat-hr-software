// Run one sync pass by hand, without starting the scheduler.
//
//   npm run sync:once                 pull new punches once
//   npm run sync:employees            pull the roster + terminals and refresh link suggestions
//   npm run sync:once -- --catchup    re-scan the trailing window for late uploads
//   npm run sync:once -- --suggest    recompute name-match suggestions only
import { logger } from '../lib/logger';
import { assertDbReachable, disconnectDb } from '../lib/db';
import { syncTransactions, catchUpTransactions } from '../sync/syncTransactions';
import { syncEmployees, refreshSuggestions } from '../sync/syncEmployees';
import { parseArgs, flag, num } from './args';

async function main(): Promise<void> {
  const args = parseArgs();
  await assertDbReachable();

  if (flag(args, 'suggest')) {
    const updated = await refreshSuggestions();
    logger.info({ updated }, 'match suggestions refreshed');
    return;
  }

  if (flag(args, 'employees')) {
    const result = await syncEmployees();
    logger.info(result, 'employee sync complete');

    if (result.unmatched + result.ambiguous > 0) {
      logger.warn(
        { unmatched: result.unmatched, ambiguous: result.ambiguous },
        'device codes awaiting mapping — open HR > Devices & Mapping to resolve them'
      );
    }
    return;
  }

  if (flag(args, 'catchup')) {
    const days = num(args, 'days', 3);
    const result = await catchUpTransactions(days);
    logger.info(result, 'catch-up complete');
    return;
  }

  const result = await syncTransactions();
  logger.info(result, 'transaction sync complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'sync failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
