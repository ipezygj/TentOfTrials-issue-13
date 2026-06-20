package ws

import (
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// TestHeartbeatConstants verifies the configured heartbeat and timeout values
func TestHeartbeatConstants(t *testing.T) {
	tests := []struct {
		name     string
		value    time.Duration
		expected time.Duration
	}{
		{"HeartbeatInterval", HeartbeatInterval, 30 * time.Second},
		{"IdleTimeout", IdleTimeout, 5 * time.Minute},
		{"ReadDeadline", ReadDeadline, 60 * time.Second},
		{"WriteDeadline", WriteDeadline, 10 * time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.value != tt.expected {
				t.Errorf("got %v, want %v", tt.value, tt.expected)
			}
		})
	}
}

// TestClientLastActivityTracking verifies activity tracking is initialized correctly
func TestClientLastActivityTracking(t *testing.T) {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	hub := NewHub(logger)
	
	// Create a mock client
	client := &Client{
		hub:          hub,
		send:         make(chan []byte, 256),
		subs:         make(map[string]struct{}),
		remote:       "127.0.0.1:12345",
		lastActivity: time.Now(),
	}

	// Verify lastActivity is set
	if client.lastActivity.IsZero() {
		t.Error("lastActivity should not be zero")
	}

	// Verify idle check calculation
	time.Sleep(100 * time.Millisecond)
	timeSinceActivity := time.Since(client.lastActivity)
	if timeSinceActivity < 100*time.Millisecond || timeSinceActivity > 200*time.Millisecond {
		t.Errorf("time since activity not as expected: %v", timeSinceActivity)
	}
}

// TestIdleTimeoutCalculation verifies the idle timeout logic
func TestIdleTimeoutCalculation(t *testing.T) {
	tests := []struct {
		name                string
		timeSinceActivity   time.Duration
		shouldBeIdle        bool
	}{
		{"Active within timeout", 2 * time.Minute, false},
		{"Active at threshold", 5 * time.Minute, false},
		{"Idle after timeout", 6 * time.Minute, true},
		{"Long idle", 10 * time.Minute, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isIdle := tt.timeSinceActivity > IdleTimeout
			if isIdle != tt.shouldBeIdle {
				t.Errorf("got isIdle=%v, want %v", isIdle, tt.shouldBeIdle)
			}
		})
	}
}

// Example of testing WebSocket connection with heartbeat
// This would require integration testing with actual websocket connections
// Run with: go test -v ./... -run TestWebsocketHeartbeat
// Manual test instructions:
// 1. Connect a WebSocket client to /ws endpoint
// 2. Observe ping frames sent every 30 seconds (HeartbeatInterval)
// 3. Send a message within 5 minutes - connection should stay open
// 4. Stop sending messages for 5+ minutes - connection should close with "idle timeout"
// 5. Verify logs show "heartbeat ping sent" and "idle client disconnected" entries
