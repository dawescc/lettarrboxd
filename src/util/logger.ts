import pino from 'pino';
import env from './env';

import { getJobId } from './context';

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

type LogFn = (msg: string | object, ...args: any[]) => void;

function wrapLogMethod(method: LogFn): LogFn {
    return (msg: string | object, ...args: any[]) => {
        const jobId = getJobId();
        if (jobId) {
            if (typeof msg === 'string') {
                method(`[${jobId}] ${msg}`, ...args);
            } else if (typeof msg === 'object' && msg !== null) {
                method({ ...msg, jobId }, ...args);
            } else {
                method(msg, ...args);
            }
        } else {
            method(msg, ...args);
        }
    };
}

const logger = new Proxy(pinoLogger, {
    get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        // Using plain casting to avoid complex overloading issues
        if (typeof value === 'function' && ['info', 'warn', 'error', 'debug', 'trace', 'fatal'].includes(prop as string)) {
            return wrapLogMethod(value.bind(target) as LogFn);
        }
        return value;
    }
});

export default logger;