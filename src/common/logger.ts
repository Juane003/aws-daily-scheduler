import { Logger } from '@aws-lambda-powertools/logger';

/** Shared structured JSON logger (Powertools). Handlers append job context per message. */
export const logger = new Logger({ serviceName: 'daily-scheduler' });
