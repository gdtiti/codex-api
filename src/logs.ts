import { EventEmitter } from 'events';

export interface LogEvent {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  meta?: Record<string, any>;
}

class LogStream extends EventEmitter {
  private buffer: LogEvent[] = [];
  private maxBuffer = 200;

  emit(event: 'log', log: LogEvent): boolean;
  emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  push(level: LogEvent['level'], message: string, meta?: Record<string, any>) {
    const entry: LogEvent = {
      timestamp: Date.now(),
      level,
      message,
      meta,
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
    }
    this.emit('log', entry);
  }

  getRecent(count = 50): LogEvent[] {
    return this.buffer.slice(-count);
  }
}

export const logStream = new LogStream();
