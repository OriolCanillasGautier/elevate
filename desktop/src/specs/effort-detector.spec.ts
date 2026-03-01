import { EffortDetector } from "@elevate/shared/sync/compute/effort-detector";
import { DetectedEffort } from "@elevate/shared/models/ftp-estimate.model";

describe("EffortDetector", () => {
  const ATHLETE_WEIGHT = 70;

  /**
   * Helper: generate a simulated ride with constant power for a given duration.
   */
  function generateSteadyRide(
    durationSeconds: number,
    powerWatts: number,
    heartRate: number = 150,
    cadence: number = 90
  ): {
    time: number[];
    power: number[];
    hr: number[];
    cadence: number[];
  } {
    const time: number[] = [];
    const power: number[] = [];
    const hr: number[] = [];
    const cad: number[] = [];

    for (let i = 0; i <= durationSeconds; i++) {
      time.push(i);
      // Add small variability to simulate real data
      power.push(powerWatts + (Math.random() - 0.5) * 10);
      hr.push(heartRate + (Math.random() - 0.5) * 5);
      cad.push(cadence + (Math.random() - 0.5) * 4);
    }

    return { time, power, hr, cadence: cad };
  }

  /**
   * Helper: generate a ride with an interval effort embedded at a specific time.
   */
  function generateRideWithInterval(
    totalDuration: number,
    intervalStart: number,
    intervalDuration: number,
    basePower: number,
    intervalPower: number
  ): {
    time: number[];
    power: number[];
    hr: number[];
    cadence: number[];
  } {
    const time: number[] = [];
    const power: number[] = [];
    const hr: number[] = [];
    const cad: number[] = [];

    for (let i = 0; i <= totalDuration; i++) {
      time.push(i);
      const inInterval = i >= intervalStart && i < intervalStart + intervalDuration;
      power.push(inInterval ? intervalPower + (Math.random() - 0.5) * 15 : basePower + (Math.random() - 0.5) * 10);
      hr.push(inInterval ? 170 + (Math.random() - 0.5) * 5 : 130 + (Math.random() - 0.5) * 5);
      cad.push(90 + (Math.random() - 0.5) * 4);
    }

    return { time, power, hr, cadence: cad };
  }

  it("should return empty for insufficient data", () => {
    // Given
    const time = [0, 1, 2, 3, 4];
    const power = [200, 210, 205, 195, 200];

    // When
    const efforts = EffortDetector.detect(time, power, null, null, ATHLETE_WEIGHT);

    // Then
    expect(efforts).toEqual([]);
  });

  it("should return empty for empty arrays", () => {
    expect(EffortDetector.detect([], [], null, null, ATHLETE_WEIGHT)).toEqual([]);
  });

  it("should detect efforts from a steady 20-minute ride", () => {
    // Given: a 25-minute ride at ~250W
    const ride = generateSteadyRide(25 * 60, 250, 160, 90);

    // When
    const efforts = EffortDetector.detect(ride.time, ride.power, ride.hr, ride.cadence, ATHLETE_WEIGHT);

    // Then
    expect(efforts.length).toBeGreaterThan(0);

    // Best effort should be close to 250W avg
    const bestByPower = efforts.sort((a, b) => b.avgPower - a.avgPower)[0];
    expect(bestByPower.avgPower).toBeGreaterThan(240);
    expect(bestByPower.avgPower).toBeLessThan(260);
  });

  it("should detect interval efforts embedded in an easy ride", () => {
    // Given: a 90-minute ride with a 10-min interval at 300W starting at minute 30
    const ride = generateRideWithInterval(90 * 60, 30 * 60, 10 * 60, 120, 300);

    // When
    const efforts = EffortDetector.detect(ride.time, ride.power, ride.hr, ride.cadence, ATHLETE_WEIGHT);

    // Then: should detect the interval effort
    expect(efforts.length).toBeGreaterThan(0);

    // At least one effort should have avg power above 280W (the interval)
    const highPowerEfforts = efforts.filter(e => e.avgPower > 280);
    expect(highPowerEfforts.length).toBeGreaterThan(0);
  });

  it("should compute quality scores > 0 for valid efforts", () => {
    // Given
    const ride = generateSteadyRide(20 * 60, 200, 150, 85);

    // When
    const efforts = EffortDetector.detect(ride.time, ride.power, ride.hr, ride.cadence, ATHLETE_WEIGHT);

    // Then: all efforts should have positive quality scores
    for (const effort of efforts) {
      expect(effort.qualityScore).toBeGreaterThan(0);
      expect(effort.qualityScore).toBeLessThanOrEqual(1);
    }
  });

  it("should compute variability index for efforts", () => {
    // Given
    const ride = generateSteadyRide(20 * 60, 200, 150, 85);

    // When
    const efforts = EffortDetector.detect(ride.time, ride.power, ride.hr, ride.cadence, ATHLETE_WEIGHT);

    // Then: steady ride should have low variability index
    for (const effort of efforts) {
      expect(effort.variabilityIndex).toBeGreaterThan(0.9);
      expect(effort.variabilityIndex).toBeLessThan(1.2); // Steady ride
    }
  });

  it("should include heart rate data when available", () => {
    // Given
    const ride = generateSteadyRide(10 * 60, 250, 160, 90);

    // When
    const efforts = EffortDetector.detect(ride.time, ride.power, ride.hr, ride.cadence, ATHLETE_WEIGHT);

    // Then
    const effortWithHR = efforts.find(e => e.avgHeartRate !== null);
    expect(effortWithHR).toBeDefined();
    expect(effortWithHR.avgHeartRate).toBeGreaterThan(100);
  });

  it("should handle null heart rate and cadence gracefully", () => {
    // Given
    const ride = generateSteadyRide(10 * 60, 250);

    // When
    const efforts = EffortDetector.detect(ride.time, ride.power, null, null, ATHLETE_WEIGHT);

    // Then: should still detect efforts
    expect(efforts.length).toBeGreaterThan(0);
    for (const effort of efforts) {
      // HR/cadence may or may not be null depending on the processing
      expect(effort.avgPower).toBeGreaterThan(0);
    }
  });

  it("should filter out very low power efforts", () => {
    // Given: a very low power ride (recovery spin)
    const ride = generateSteadyRide(30 * 60, 30, 100, 65);

    // When
    const efforts = EffortDetector.detect(ride.time, ride.power, ride.hr, ride.cadence, ATHLETE_WEIGHT);

    // Then: should not detect meaningful efforts at 30W
    expect(efforts.length).toEqual(0);
  });

  it("should sort results by quality score descending", () => {
    // Given
    const ride = generateRideWithInterval(60 * 60, 10 * 60, 10 * 60, 150, 280);

    // When
    const efforts = EffortDetector.detect(ride.time, ride.power, ride.hr, ride.cadence, ATHLETE_WEIGHT);

    // Then: should be sorted by quality score descending
    for (let i = 1; i < efforts.length; i++) {
      expect(efforts[i].qualityScore).toBeLessThanOrEqual(efforts[i - 1].qualityScore);
    }
  });
});
