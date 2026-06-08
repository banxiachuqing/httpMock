export class LogBuffer {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.entries = [];
    this.subscribers = new Set();
  }

  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.splice(0, this.entries.length - this.maxSize);
    }
    for (const fn of this.subscribers) {
      try { fn(entry); } catch {}
    }
  }

  getRecent(limit = 100) {
    if (limit >= this.entries.length) return [...this.entries];
    return this.entries.slice(this.entries.length - limit);
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  clear() {
    this.entries = [];
  }
}
