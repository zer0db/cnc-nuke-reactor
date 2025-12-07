package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/zer0db/cnc-nuke-reactor/reactor"
)

func main() {
	// Initialize the simulation backend
	sim := reactor.NewReactor()

	// SSE clients management
	var clientsMu sync.Mutex
	clients := make(map[chan []byte]struct{})

	// Update loop (runs the simulation)
	ticker := time.NewTicker(50 * time.Millisecond)
	go func() {
		lastJSON := []byte{}
		for range ticker.C {
			sim.Update(0.2) // delta seconds
			snap := sim.Snapshot()
			j, _ := json.Marshal(snap)

			// Broadcast only if changed
			if string(j) != string(lastJSON) {
				lastJSON = j
				clientsMu.Lock()
				for ch := range clients {
					select {
					case ch <- j:
					default:
					}
				}
				clientsMu.Unlock()
			}
		}
	}()

	// --- API Handlers ---

	// State Snapshot Endpoint
	http.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		j, _ := json.Marshal(sim.Snapshot())
		w.Header().Set("Content-Type", "application/json")
		w.Write(j)
	})

	// Action Endpoint: POST JSON { "type":"setFissionRate", "value": 42 }
	http.HandleFunc("/api/action", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var payload struct {
			Type  string  `json:"type"`
			Value float64 `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		// Delegate commands to backend methods
		switch payload.Type {
		case "powerOn":
			sim.PowerOn()
		case "powerOff":
			sim.PowerOff()
		case "scram":
			sim.Scram()
		case "toggleAuto":
			sim.ToggleAuto()
		case "refuel":
			sim.Refuel()
		case "setFissionRate":
			sim.SetFissionRate(payload.Value)
		case "setTurbineOutput":
			sim.SetTurbineOutput(payload.Value)
		case "setPowerLoad":
			sim.SetPowerLoad(payload.Value)
		default:
			http.Error(w, "unknown action", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// Server-Sent Events (SSE) Endpoint
	http.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		ch := make(chan []byte, 1)
		clientsMu.Lock()
		clients[ch] = struct{}{}
		clientsMu.Unlock()

		// Send immediate snapshot on connect
		j, _ := json.Marshal(sim.Snapshot())
		_, _ = w.Write([]byte("data: " + string(j) + "\n\n"))
		flusher.Flush()

		notify := r.Context().Done()
		for {
			select {
			case <-notify:
				clientsMu.Lock()
				delete(clients, ch)
				clientsMu.Unlock()
				return
			case msg := <-ch:
				_, _ = w.Write([]byte("data: " + string(msg) + "\n\n"))
				flusher.Flush()
			}
		}
	})

	// Static File Server
	staticDir := "frontend/"
	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		staticDir = filepath.Join(".", "static")
	}
	http.Handle("/", http.FileServer(http.Dir(staticDir)))

	port := 80
	log.Printf("server listening :%d (static: %s)\n", port, staticDir)
	log.Fatal(http.ListenAndServe(":"+strconv.Itoa(port), nil))
}
