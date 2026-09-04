type RuntimeEventListener = (data?: unknown) => void;

class RuntimeEventBus {
  listeners = new Map<string, Set<RuntimeEventListener>>();
  buffer = new Map<string, unknown>();
  eventHistory: Array<{ event: string; timestamp: number; dataSize: number }> = [];
  maxHistorySize = 100;

  subscribe(event: string, listener: RuntimeEventListener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    this.listeners.get(event)!.add(listener);

    if (this.buffer.has(event)) {
      try {
        listener(this.buffer.get(event));
      } catch (error) {
        console.error(`Error in buffered event delivery for ${event}:`, error);
      }
    }

    return () => {
      const listeners = this.listeners.get(event);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  emit(event: string, data: unknown = undefined) {
    this.trackEvent(event, data);

    const listeners = this.listeners.get(event);
    if (!listeners || listeners.size === 0) {
      this.buffer.set(event, data);
      return;
    }

    this.buffer.delete(event);
    listeners.forEach((listener) => {
      try {
        listener(data);
      } catch (error) {
        console.error(`Error in listener for event ${event}:`, error);
      }
    });
  }

  trackEvent(event: string, data: unknown) {
    this.eventHistory.push({
      event,
      timestamp: Date.now(),
      dataSize: data ? JSON.stringify(data).length : 0,
    });

    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }
  }

  getStatistics() {
    const stats: Record<string, number> = {};
    this.eventHistory.forEach(({ event }) => {
      stats[event] = (stats[event] || 0) + 1;
    });
    return stats;
  }

  clear() {
    this.listeners.clear();
    this.buffer.clear();
  }
}

export const runtimeEventBus = new RuntimeEventBus();

export const RuntimeEvents = {
  FILE_OPEN: "file:open",
  CODE_CHANGE: "code:change",
  CONTEXT_UPDATE: "kg:context:update",
  CONTEXT_QUERY: "kg:context:query",
  TOKEN_USAGE: "kg:token:usage",
  CACHE_HIT: "kg:cache:hit",
  CACHE_MISS: "kg:cache:miss",
} as const;

export default RuntimeEventBus;