package ws

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// TestHeartbeatInterval verifies the heartbeat interval configuration.
func TestHeartbeatInterval(t *testing.T) {
	tests := []struct {
		name     string
		envValue string
		expected time.Duration
	}{
		{
			name:     "default interval",
			envValue: "",
			expected: 30 * time.Second,
		},
		{
			name:     "custom interval",
			envValue: "15",
			expected: 15 * time.Second,
		},
		{
			name:     "invalid value defaults to 30",
			envValue: "invalid",
			expected: 30 * time.Second,
		},
		{
			name:     "zero value defaults to 30",
			envValue: "0",
			expected: 30 * time.Second,
		},
		{
			name:     "negative value defaults to 30",
			envValue: "-5",
			expected: 30 * time.Second,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			oldValue := os.Getenv("WS_HEARTBEAT_INTERVAL_SECS")
			defer os.Setenv("WS_HEARTBEAT_INTERVAL_SECS", oldValue)

			if tt.envValue == "" {
				os.Unsetenv("WS_HEARTBEAT_INTERVAL_SECS")
			} else {
				os.Setenv("WS_HEARTBEAT_INTERVAL_SECS", tt.envValue)
			}

			interval := getHeartbeatInterval()
			if interval != tt.expected {
				t.Errorf("getHeartbeatInterval() = %v, want %v", interval, tt.expected)
			}
		})
	}
}

// TestClientConnection verifies that clients can connect and disconnect.
func TestClientConnection(t *testing.T) {
	logger := zap.NewNop()
	hub := NewHub(logger)
	go hub.Run()
	defer hub.Stop()

	// Create WebSocket server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade error: %v", err)
		}

		client := &Client{
			hub:          hub,
			conn:         conn,
			send:         make(chan []byte, 256),
			subs:         make(map[interface{}]struct{}),
			remote:       r.RemoteAddr,
			lastPongTime: time.Now(),
		}

		hub.register <- client
		go client.readPump()
		go client.writePump()
	}))
	defer server.Close()

	// Connect client
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}
	defer ws.Close()

	// Verify client is registered
	time.Sleep(100 * time.Millisecond)
	hub.mu.RLock()
	if len(hub.clients) != 1 {
		t.Errorf("expected 1 client, got %d", len(hub.clients))
	}
	hub.mu.RUnlock()

	// Disconnect
	ws.Close()
	time.Sleep(100 * time.Millisecond)

	// Verify client is unregistered
	hub.mu.RLock()
	if len(hub.clients) != 0 {
		t.Errorf("expected 0 clients after disconnect, got %d", len(hub.clients))
	}
	hub.mu.RUnlock()
}

// TestIdleConnectionCleanup verifies that idle connections are closed.
func TestIdleConnectionCleanup(t *testing.T) {
	// Set heartbeat interval to 100ms for faster testing
	oldValue := os.Getenv("WS_HEARTBEAT_INTERVAL_SECS")
	defer os.Setenv("WS_HEARTBEAT_INTERVAL_SECS", oldValue)
	os.Setenv("WS_HEARTBEAT_INTERVAL_SECS", "0")

	logger := zap.NewNop()
	hub := NewHub(logger)

	// Override the heartbeat interval for this test
	hub.heartbeatInterval = 100 * time.Millisecond
	hub.idleCheckTicker = time.NewTicker(hub.heartbeatInterval * 2)

	go hub.Run()
	defer hub.Stop()

	// Create a mock client that never responds to pings
	client := &Client{
		hub:    hub,
		conn:   nil,
		send:   make(chan []byte, 256),
		subs:   make(map[interface{}]struct{}),
		remote: "127.0.0.1:12345",
		// Do NOT update lastPongTime to simulate idle client
		lastPongTime: time.Now().Add(-1 * time.Hour),
	}

	hub.mu.Lock()
	hub.clients[client] = struct{}{}
	initialCount := len(hub.clients)
	hub.mu.Unlock()

	if initialCount != 1 {
		t.Fatalf("expected 1 client registered, got %d", initialCount)
	}

	// Trigger idle check
	hub.checkIdleConnections()

	// Verify idle client was removed
	hub.mu.RLock()
	if len(hub.clients) != 0 {
		t.Errorf("expected idle client to be removed, but %d clients remain", len(hub.clients))
	}
	hub.mu.RUnlock()
}

// TestActiveClientNotRemoved verifies that active (recent pong) clients are not removed.
func TestActiveClientNotRemoved(t *testing.T) {
	logger := zap.NewNop()
	hub := NewHub(logger)
	hub.heartbeatInterval = 100 * time.Millisecond
	go hub.Run()
	defer hub.Stop()

	// Create a mock client with recent pong
	client := &Client{
		hub:          hub,
		conn:         nil,
		send:         make(chan []byte, 256),
		subs:         make(map[interface{}]struct{}),
		remote:       "127.0.0.1:12345",
		lastPongTime: time.Now(),
	}

	hub.mu.Lock()
	hub.clients[client] = struct{}{}
	hub.mu.Unlock()

	// Trigger idle check
	hub.checkIdleConnections()

	// Verify client is still present
	hub.mu.RLock()
	if len(hub.clients) != 1 {
		t.Errorf("expected active client to remain, but %d clients exist", len(hub.clients))
	}
	hub.mu.RUnlock()
}

// BenchmarkHeartbeatInterval benchmarks the interval getter.
func BenchmarkHeartbeatInterval(b *testing.B) {
	os.Setenv("WS_HEARTBEAT_INTERVAL_SECS", "30")
	defer os.Unsetenv("WS_HEARTBEAT_INTERVAL_SECS")

	for i := 0; i < b.N; i++ {
		getHeartbeatInterval()
	}
}
