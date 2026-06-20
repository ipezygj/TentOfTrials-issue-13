import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocketClient } from '../websocket';

describe('WebSocketClient', () => {
  describe('backoff calculation', () => {
    let client: WebSocketClient;

    beforeEach(() => {
      client = new WebSocketClient({
        url: 'ws://localhost:8080',
        reconnectBaseDelay: 1000,
        reconnectMaxDelay: 30000,
        reconnectJitter: 1000,
      });
    });

    it('should use base delay for first attempt', () => {
      const delay = client.calculateBackoffDelay(0);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000); // base + max jitter
    });

    it('should double delay with each attempt', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // Fixed jitter for predictable tests
      const delays = [
        client.calculateBackoffDelay(0), // 1000 + 500 = 1500
        client.calculateBackoffDelay(1), // 2000 + 500 = 2500
        client.calculateBackoffDelay(2), // 4000 + 500 = 4500
        client.calculateBackoffDelay(3), // 8000 + 500 = 8500
      ];

      expect(delays[0]).toBe(1500);
      expect(delays[1]).toBe(2500);
      expect(delays[2]).toBe(4500);
      expect(delays[3]).toBe(8500);
    });

    it('should cap delay at maxDelay', () => {
      const delay = client.calculateBackoffDelay(10); // 2^10 * 1000 = 1024000
      expect(delay).toBeLessThanOrEqual(31000); // maxDelay + max jitter
    });

    it('should add jitter to prevent thundering herd', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const delay = client.calculateBackoffDelay(0);
      expect(delay).toBe(1500); // 1000 + (0.5 * 1000)
    });

    it('should use full jitter range', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const delayMin = client.calculateBackoffDelay(0);
      expect(delayMin).toBe(1000);

      vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const delayMax = client.calculateBackoffDelay(0);
      expect(delayMax).toBeCloseTo(1999, 0);
    });
  });

  describe('connection state transitions', () => {
    let client: WebSocketClient;
    let stateChanges: string[] = [];

    beforeEach(() => {
      stateChanges = [];
      client = new WebSocketClient({
        url: 'ws://localhost:8080',
        onStateChange: (state) => stateChanges.push(state),
        reconnect: false, // Disable auto-reconnect for state tests
      });
    });

    it('should start in disconnected state', () => {
      expect(client.connectionState).toBe('disconnected');
    });

    it('should transition to connecting when connect() is called', () => {
      client.connect();
      expect(stateChanges).toContain('connecting');
    });

    it('should expose isConnected getter', () => {
      expect(client.isConnected).toBe(false);
    });

    it('should track queue size', () => {
      expect(client.queueSize).toBe(0);
      client.send({ type: 'test', payload: {} });
      expect(client.queueSize).toBe(1);
    });
  });

  describe('message queue', () => {
    let client: WebSocketClient;

    beforeEach(() => {
      client = new WebSocketClient({
        url: 'ws://localhost:8080',
        messageQueueSize: 3,
        debug: false,
      });
    });

    it('should queue messages when disconnected', () => {
      client.send({ type: 'msg1', payload: {} });
      client.send({ type: 'msg2', payload: {} });
      expect(client.queueSize).toBe(2);
    });

    it('should drop messages when queue is full', () => {
      client.send({ type: 'msg1', payload: {} });
      client.send({ type: 'msg2', payload: {} });
      client.send({ type: 'msg3', payload: {} });
      client.send({ type: 'msg4', payload: {} }); // Should be dropped
      expect(client.queueSize).toBe(3);
    });
  });

  describe('subscription management', () => {
    let client: WebSocketClient;

    beforeEach(() => {
      client = new WebSocketClient({
        url: 'ws://localhost:8080',
      });
    });

    it('should allow subscribing to channels', () => {
      const callback = vi.fn();
      client.subscribe('test-channel', callback);
      // Subscription tracking is internal, just verify no errors
      expect(callback).not.toHaveBeenCalled();
    });

    it('should allow unsubscribing from channels', () => {
      const callback = vi.fn();
      client.subscribe('test-channel', callback);
      client.unsubscribe('test-channel');
      // No errors = success
    });
  });

  describe('cleanup', () => {
    it('should clean up resources on destroy', () => {
      const client = new WebSocketClient({ url: 'ws://localhost:8080' });
      client.destroy();
      expect(() => client.connect()).toThrow('WebSocketClient has been destroyed');
    });

    it('should clear queue on destroy', () => {
      const client = new WebSocketClient({ url: 'ws://localhost:8080' });
      client.send({ type: 'test', payload: {} });
      expect(client.queueSize).toBe(1);
      client.destroy();
      expect(client.queueSize).toBe(0);
    });
  });
});
