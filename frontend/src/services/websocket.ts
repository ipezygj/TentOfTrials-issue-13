/**
 * Reusable WebSocket client with reconnect backoff.
 *
 * Features:
 * - Exponential backoff with jitter on disconnects
 * - Max delay cap at 30 seconds
 * - Connection state tracking
 * - Message queue for offline delivery
 * - Heartbeat (ping/pong) support
 * - Subscription management for multiplexed channels
 *
 * Reconnection strategy:
 *   delay = min(base * 2^attempt, maxDelay) + random(0, jitter)
 *
 * After a stable connection (default: 30s), the reconnect attempt counter
 * resets to 0, ensuring that transient failures don't permanently degrade
 * reconnection speed.
 */

export type WSConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface WSMessage {
  type: string;
  channel?: string;
  payload: unknown;
  id?: string;
  timestamp?: number;
}

export interface WSClientOptions {
  url: string;
  protocols?: string | string[];
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  reconnectJitter?: number;
  stableConnectionThreshold?: number;
  pingInterval?: number;
  pongTimeout?: number;
  messageQueueSize?: number;
  debug?: boolean;
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  onMessage?: (message: WSMessage) => void;
  onStateChange?: (state: WSConnectionState) => void;
}

interface QueuedMessage {
  message: WSMessage;
  timestamp: number;
}

const DEFAULT_OPTIONS = {
  reconnect: true,
  maxReconnectAttempts: 10,
  reconnectBaseDelay: 1000,
  reconnectMaxDelay: 30000,
  reconnectJitter: 1000,
  stableConnectionThreshold: 30000,
  pingInterval: 30000,
  pongTimeout: 10000,
  messageQueueSize: 100,
  debug: false,
};

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private options: Required<Omit<WSClientOptions, 'url' | 'protocols' | 'onOpen' | 'onClose' | 'onError' | 'onMessage' | 'onStateChange'>> & WSClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: QueuedMessage[] = [];
  private subscriptions = new Map<string, (data: unknown) => void>();
  private reconnectAttempt = 0;
  private state: WSConnectionState = 'disconnected';
  private destroyed = false;
  private pingStart = 0;
  private _latencyMs: number | null = null;

  constructor(options: WSClientOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get connectionState(): WSConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get latencyMs(): number | null {
    return this._latencyMs;
  }

  get queueSize(): number {
    return this.messageQueue.length;
  }

  connect(): void {
    if (this.destroyed) {
      throw new Error('WebSocketClient has been destroyed');
    }

    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.setState('connecting');

    try {
      this.ws = new WebSocket(this.options.url, this.options.protocols);

      this.ws.onopen = (event) => {
        this.reconnectAttempt = 0;
        this.setState('connected');
        this.startStableTimer();
        this.resubscribeAll();
        this.flushQueue();
        this.startPing();
        this.options.onOpen?.(event);
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);

          if (message.type === 'pong') {
            this._latencyMs = Date.now() - this.pingStart;
            this.clearPongTimeout();
            return;
          }

          if (message.channel) {
            const handler = this.subscriptions.get(message.channel);
            if (handler) {
              try {
                handler(message.payload);
              } catch (err) {
                if (this.options.debug) {
                  console.error(`[WebSocketClient] Subscription handler error for channel ${message.channel}:`, err);
                }
              }
            }
          }

          this.options.onMessage?.(message);
        } catch (err) {
          if (this.options.debug) {
            console.error('[WebSocketClient] Failed to parse message:', err);
          }
        }
      };

      this.ws.onclose = (event) => {
        this.ws = null;
        this.stopPing();
        this.stopStableTimer();
        this.setState('disconnected');
        this.options.onClose?.(event);
        this.scheduleReconnect();
      };

      this.ws.onerror = (event) => {
        this.setState('error');
        this.options.onError?.(event);
      };
    } catch (err) {
      this.setState('error');
      if (this.options.debug) {
        console.error('[WebSocketClient] Connection error:', err);
      }
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.stopPing();
    this.stopStableTimer();
    this.setState('disconnected');
    this.reconnectAttempt = 0;
  }

  destroy(): void {
    this.disconnect();
    this.subscriptions.clear();
    this.messageQueue = [];
    this.destroyed = true;
  }

  send(message: WSMessage): void {
    const msgStr = JSON.stringify(message);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msgStr);
    } else {
      if (this.messageQueue.length < this.options.messageQueueSize) {
        this.messageQueue.push({ message, timestamp: Date.now() });
      } else if (this.options.debug) {
        console.warn('[WebSocketClient] Message queue full, dropping message:', message.type);
      }
    }
  }

  subscribe(channel: string, callback: (data: unknown) => void, filter?: Record<string, unknown>): void {
    this.subscriptions.set(channel, callback);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'subscribe',
        channel,
        payload: filter || {},
      });
    }
  }

  unsubscribe(channel: string): void {
    this.subscriptions.delete(channel);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'unsubscribe',
        channel,
        payload: null,
      });
    }
  }

  /**
   * Calculate next reconnect delay with exponential backoff and jitter.
   * Public for testing purposes.
   */
  calculateBackoffDelay(attempt: number): number {
    const exponential = this.options.reconnectBaseDelay * Math.pow(2, attempt);
    const capped = Math.min(exponential, this.options.reconnectMaxDelay);
    const jitter = Math.random() * this.options.reconnectJitter;
    return capped + jitter;
  }

  private setState(newState: WSConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.options.onStateChange?.(newState);
    }
  }

  private scheduleReconnect(): void {
    if (!this.options.reconnect || this.reconnectAttempt >= this.options.maxReconnectAttempts || this.destroyed) {
      if (this.reconnectAttempt >= this.options.maxReconnectAttempts) {
        this.setState('error');
      }
      return;
    }

    const delay = this.calculateBackoffDelay(this.reconnectAttempt);
    this.reconnectAttempt++;

    if (this.options.debug) {
      console.log(`[WebSocketClient] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`);
    }

    this.setState('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) {
        this.connect();
      }
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.pingStart = Date.now();
        this.ws.send(JSON.stringify({ type: 'ping' }));

        this.pongTimer = setTimeout(() => {
          if (this.options.debug) {
            console.warn('[WebSocketClient] Pong timeout, closing connection');
          }
          this._latencyMs = null;
          this.ws?.close(4000, 'Pong timeout');
        }, this.options.pongTimeout);
      }
    }, this.options.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimeout();
  }

  private clearPongTimeout(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private startStableTimer(): void {
    this.stopStableTimer();
    this.stableTimer = setTimeout(() => {
      this.reconnectAttempt = 0;
      if (this.options.debug) {
        console.log('[WebSocketClient] Connection stable, reset reconnect counter');
      }
    }, this.options.stableConnectionThreshold);
  }

  private stopStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private resubscribeAll(): void {
    this.subscriptions.forEach((callback, channel) => {
      this.send({
        type: 'subscribe',
        channel,
        payload: {},
      });
    });
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const queued = this.messageQueue.shift()!;
      this.send(queued.message);
    }
  }
}
