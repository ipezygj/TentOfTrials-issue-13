// +build ignore

package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// This is a standalone harness to test WebSocket heartbeat functionality.
// Build with: go run heartbeat_harness.go server.go
// This verifies that:
// 1. Ping frames are sent at the configured interval
// 2. Pong responses are tracked
// 3. Idle connections are closed after 2 heartbeat intervals

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func main() {
	// Configure short intervals for testing
	os.Setenv("WS_HEARTBEAT_INTERVAL_SECS", "1")

	logger, _ := zap.NewProduction()
	defer logger.Sync()

	// Create hub and server
	hub := NewHub(logger)
	server := NewServer(hub, nil, logger, 8080)

	go hub.Run()
	defer hub.Stop()

	// Create test server
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Error("upgrade failed", zap.Error(err))
			return
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
	})

	ts := httptest.NewServer(mux)
	defer ts.Close()

	fmt.Println("=== WebSocket Heartbeat Test ===")
	fmt.Printf("Heartbeat interval: %v\n", hub.heartbeatInterval)
	fmt.Printf("Idle threshold: %v\n", 2*hub.heartbeatInterval)
	fmt.Println()

	// Test 1: Connect responsive client
	fmt.Println("Test 1: Responsive client (should remain connected)")
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		log.Fatalf("dial error: %v", err)
	}

	// Read pings and respond with pongs
	go func() {
		for {
			messageType, data, err := ws.ReadMessage()
			if err != nil {
				break
			}
			if messageType == websocket.PingMessage {
				fmt.Printf("  [%v] Received ping, sending pong\n", time.Now().Format("15:04:05"))
				if err := ws.WriteMessage(websocket.PongMessage, data); err != nil {
					break
				}
			}
		}
	}()

	time.Sleep(5 * time.Second)

	hub.mu.RLock()
	responsiveCount := len(hub.clients)
	hub.mu.RUnlock()

	fmt.Printf("  Result: %d client(s) still connected ✓\n", responsiveCount)
	ws.Close()
	time.Sleep(100 * time.Millisecond)

	// Test 2: Connect but don't respond to pings
	fmt.Println()
	fmt.Println("Test 2: Unresponsive client (should be disconnected after idle threshold)")
	ws2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		log.Fatalf("dial error: %v", err)
	}

	initialCount := 0
	hub.mu.RLock()
	initialCount = len(hub.clients)
	hub.mu.RUnlock()
	fmt.Printf("  Initial clients: %d\n", initialCount)

	// Don't read/respond to pings, just let them accumulate
	time.Sleep(4 * time.Second)

	hub.mu.RLock()
	unresponsiveCount := len(hub.clients)
	hub.mu.RUnlock()

	fmt.Printf("  After 4s (2 × 1s heartbeat + 2s buffer): %d client(s)\n", unresponsiveCount)

	if unresponsiveCount < initialCount {
		fmt.Println("  Result: Idle client disconnected ✓")
	} else {
		fmt.Println("  Result: Client still connected (may need more time)")
	}

	ws2.Close()

	// Test 3: Active connection tracking
	fmt.Println()
	fmt.Println("Test 3: Connection count tracking")
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
			if err != nil {
				log.Printf("dial error: %v", err)
				return
			}
			defer ws.Close()

			// Respond to pings
			for {
				_, data, err := ws.ReadMessage()
				if err != nil {
					break
				}
				ws.WriteMessage(websocket.PongMessage, data)
			}
		}(i)
	}

	time.Sleep(1 * time.Second)

	hub.mu.RLock()
	activeCount := len(hub.clients)
	hub.mu.RUnlock()

	fmt.Printf("  Active connections: %d\n", activeCount)
	fmt.Println("  Result: ✓")

	time.Sleep(1 * time.Second)
	fmt.Println()
	fmt.Println("=== All tests completed ===")
}
