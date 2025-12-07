package reactor

import (
	"math"
	"math/rand"
	"sync"
)

// ReactorStatus flags
type ReactorStatus uint32

const (
	StatusNone       ReactorStatus = 0
	StatusTempLow                  = 1 << 0
	StatusOverheat                 = 1 << 1
	StatusOutputLow                = 1 << 2
	StatusOutputHigh               = 1 << 3
	StatusFuelLow                  = 1 << 4
	StatusFuelOut                  = 1 << 5
	StatusMeltdown                 = 1 << 6
	StatusScram                    = 1 << 7
)

type FuelRod struct {
	Condition float64 `json:"condition"`
}

type ReactorState struct {
	IsPoweredOn   bool          `json:"isPoweredOn"`
	IsAutoControl bool          `json:"isAutoControl"`
	Temperature   float64       `json:"temperature"`
	FissionRate   float64       `json:"fissionRate"`
	TurbineOutput float64       `json:"turbineOutput"`
	PowerOutput   float64       `json:"powerOutput"`
	PowerLoad     float64       `json:"powerLoad"`
	FuelRod       *FuelRod      `json:"fuelRod"`
	Status        ReactorStatus `json:"status"`
}

type Reactor struct {
	sync.RWMutex
	state ReactorState

	// Constants are exported so they can be read by external tools if needed
	MAX_TEMP                 float64
	MAX_POWER_OUTPUT         float64
	MELTDOWN_TEMP            float64
	OVERHEAT_TEMP            float64
	LOW_TEMP                 float64
	OPTIMAL_TEMP             float64
	FUEL_CONSUMPTION_RATE    float64
	HEAT_GENERATION_RATE     float64
	AMBIENT_TEMP_DISSIPATION float64
	TURBINE_POWER_FACTOR     float64
	LOW_FUEL_THRESHOLD       float64
	baseLoad                 float64
	spikeTimer               float64 // Counts down to next spike
	isSpiking                bool
	spikeElapsed             float64
	spikeDuration            float64
	spikeMagnitude           float64
}

func NewReactor() *Reactor {
	r := &Reactor{
		MAX_TEMP:                 1000,
		MAX_POWER_OUTPUT:         5000,
		MELTDOWN_TEMP:            900,
		OVERHEAT_TEMP:            600,
		LOW_TEMP:                 200,
		OPTIMAL_TEMP:             350,
		FUEL_CONSUMPTION_RATE:    0.05,
		HEAT_GENERATION_RATE:     800,
		AMBIENT_TEMP_DISSIPATION: 0.05,
		TURBINE_POWER_FACTOR:     8,
		LOW_FUEL_THRESHOLD:       20,
	}

	initialLoad := 1000.0
	r.baseLoad = initialLoad
	r.spikeTimer = 10.0 // First spike in ~10 seconds (simulated time)
	r.spikeDuration = 10.0
	r.spikeMagnitude = 1000.0
	initialTemp := r.OPTIMAL_TEMP
	initialTurbine := initialLoad / (initialTemp / 100.0 * (initialTemp / r.OVERHEAT_TEMP) * r.TURBINE_POWER_FACTOR)
	heatConsumed := (initialLoad / r.TURBINE_POWER_FACTOR) + (initialTemp * r.AMBIENT_TEMP_DISSIPATION)
	initialFission := (heatConsumed * 100.0) / r.HEAT_GENERATION_RATE

	r.state = ReactorState{
		IsPoweredOn:   true,
		IsAutoControl: true,
		Temperature:   initialTemp,
		FissionRate:   initialFission,
		TurbineOutput: initialTurbine,
		PowerOutput:   initialLoad,
		PowerLoad:     initialLoad,
		FuelRod:       &FuelRod{Condition: 100},
		Status:        StatusNone,
	}
	return r
}

func (r *Reactor) Update(delta float64) {
	r.Lock()
	defer r.Unlock()

	r.updateGridLoad(delta)
	if !r.state.IsPoweredOn || (r.state.Status&StatusScram) != 0 {
		// shutdown cooling behaviour
		r.state.FissionRate = 0
		tempEfficiency := min(1, r.state.Temperature/r.OVERHEAT_TEMP)
		potentialPower := r.state.Temperature * (r.state.TurbineOutput / 100.0) * tempEfficiency
		r.state.PowerOutput = min(r.MAX_POWER_OUTPUT, potentialPower*r.TURBINE_POWER_FACTOR)
		heatConsumedByTurbine := r.state.PowerOutput / r.TURBINE_POWER_FACTOR
		ambientCooling := r.state.Temperature * (r.AMBIENT_TEMP_DISSIPATION * 2)
		r.state.Temperature -= (heatConsumedByTurbine + ambientCooling) * delta
		if r.state.Temperature < 0 {
			r.state.Temperature = 0
			r.state.PowerOutput = 0
		}
		r.updateStatusLocked()
		return
	}

	if r.state.IsAutoControl {
		r.runAutoControlLocked()
	}

	heatGenerated := 0.0
	if r.state.FuelRod != nil && r.state.FuelRod.Condition > 0 {
		heatGenerated = (r.state.FissionRate / 100.0) * r.HEAT_GENERATION_RATE
		r.state.Temperature += heatGenerated * delta
		fuelConsumed := (r.state.FissionRate / 100.0) * r.FUEL_CONSUMPTION_RATE * delta
		r.state.FuelRod.Condition = max(0, r.state.FuelRod.Condition-fuelConsumed)
	}

	tempEfficiency := min(1, r.state.Temperature/r.OVERHEAT_TEMP)
	potentialPower := r.state.Temperature * (r.state.TurbineOutput / 100.0) * tempEfficiency
	r.state.PowerOutput = min(r.MAX_POWER_OUTPUT, potentialPower*r.TURBINE_POWER_FACTOR)
	heatConsumedByTurbine := r.state.PowerOutput / r.TURBINE_POWER_FACTOR
	ambientCooling := r.state.Temperature * r.AMBIENT_TEMP_DISSIPATION
	r.state.Temperature -= (heatConsumedByTurbine + ambientCooling) * delta
	if r.state.Temperature < 0 {
		r.state.Temperature = 0
	}
	r.updateStatusLocked()
}

func (r *Reactor) runAutoControlLocked() {
	powerError := r.state.PowerLoad - r.state.PowerOutput
	r.state.TurbineOutput += powerError * 0.01
	tempError := r.OPTIMAL_TEMP - r.state.Temperature
	r.state.FissionRate += tempError * 0.002
	r.state.FissionRate = clamp(r.state.FissionRate, 0, 100)
	r.state.TurbineOutput = clamp(r.state.TurbineOutput, 0, 100)
}

func (r *Reactor) updateStatusLocked() {
	// preserve scram
	current := r.state.Status & StatusScram

	if r.state.Temperature >= r.MELTDOWN_TEMP {
		current |= StatusMeltdown
	} else if r.state.Temperature >= r.OVERHEAT_TEMP {
		current |= StatusOverheat
	} else if r.state.Temperature < r.LOW_TEMP && r.state.IsPoweredOn && r.state.PowerOutput > 0 {
		current |= StatusTempLow
	}

	powerDifference := r.state.PowerOutput - r.state.PowerLoad
	if powerDifference > r.state.PowerLoad*0.2 && r.state.PowerLoad > 100 {
		current |= StatusOutputHigh
	}
	if powerDifference < -r.state.PowerLoad*0.2 && r.state.PowerLoad > 100 {
		current |= StatusOutputLow
	}

	if r.state.FuelRod == nil || r.state.FuelRod.Condition <= 0 {
		current |= StatusFuelOut
		r.state.FuelRod = nil
	} else if r.state.FuelRod.Condition < r.LOW_FUEL_THRESHOLD {
		current |= StatusFuelLow
	}
	r.state.Status = current
}

func (r *Reactor) updateGridLoad(delta float64) {
	// 1. Random Walk for Base Load
	// Change ~ +/- 12 per tick.
	change := (rand.Float64() * 24) - 12
	r.baseLoad += change
	r.baseLoad = clamp(r.baseLoad, 800, 2100)

	// 2. Spike Logic
	spikeVal := 0.0

	if !r.isSpiking {
		r.spikeTimer -= delta
		if r.spikeTimer <= 0 {
			r.isSpiking = true
			r.spikeElapsed = 0
			// Schedule next spike 10-15s after this one finishes
			r.spikeTimer = 10.0 + rand.Float64()*5.0
		}
	} else {
		r.spikeElapsed += delta
		if r.spikeElapsed >= r.spikeDuration {
			r.isSpiking = false
		} else {
			// Linear decay: magnitude * (1 - progress)
			decayFactor := 1.0 - (r.spikeElapsed / r.spikeDuration)
			spikeVal = r.spikeMagnitude * decayFactor
		}
	}

	r.state.PowerLoad = math.Round(r.baseLoad + spikeVal)
}

// Control helpers
func (r *Reactor) PowerOn() {
	r.Lock()
	defer r.Unlock()
	if !r.state.IsPoweredOn {
		r.state.IsPoweredOn = true
		r.state.Status &^= StatusScram
	}
}
func (r *Reactor) PowerOff() {
	r.Lock()
	defer r.Unlock()
	r.state.IsPoweredOn = false
}
func (r *Reactor) Scram() {
	r.Lock()
	defer r.Unlock()
	r.state.Status |= StatusScram
	r.state.IsPoweredOn = false
}
func (r *Reactor) ToggleAuto() {
	r.Lock()
	defer r.Unlock()
	r.state.IsAutoControl = !r.state.IsAutoControl
}
func (r *Reactor) SetFissionRate(v float64) {
	r.Lock()
	defer r.Unlock()
	if !r.state.IsAutoControl {
		r.state.FissionRate = clamp(v, 0, 100)
	}
}
func (r *Reactor) SetTurbineOutput(v float64) {
	r.Lock()
	defer r.Unlock()
	if !r.state.IsAutoControl {
		r.state.TurbineOutput = clamp(v, 0, 100)
	}
}
func (r *Reactor) SetPowerLoad(v float64) {
	r.Lock()
	defer r.Unlock()
	r.state.PowerLoad = max(0, v)
}

func (r *Reactor) Snapshot() ReactorState {
	r.RLock()
	defer r.RUnlock()
	return r.state
}

func (r *Reactor) Refuel() {
	r.Lock()
	defer r.Unlock()
	// Replace with a fresh fuel rod at 100% condition
	r.state.FuelRod = &FuelRod{Condition: 100}
}

// Internal helpers
func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
