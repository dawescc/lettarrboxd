import pino from 'pino';
import env from './env';

const pinoLogger = pino({
    level: env.LOG_LEVEL,
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
        }
    }
});

const logger = pinoLogger;

export default logger;