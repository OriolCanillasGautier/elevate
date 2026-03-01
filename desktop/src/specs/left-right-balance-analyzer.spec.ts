import { LeftRightBalanceAnalyzer } from "@elevate/shared/sync/compute/left-right-balance-analyzer";
import { CyclingDynamicsStats } from "@elevate/shared/models/sync/activity.model";

describe("LeftRightBalanceAnalyzer", () => {
    describe("analyzeFromDynamics", () => {
        it("should return null for null dynamics", () => {
            expect(LeftRightBalanceAnalyzer.analyzeFromDynamics(null)).toBeNull();
        });

        it("should return null when balance is missing", () => {
            const dynamics = new CyclingDynamicsStats();
            dynamics.balance = null;
            expect(LeftRightBalanceAnalyzer.analyzeFromDynamics(dynamics)).toBeNull();
        });

        it("should analyze balanced power distribution", () => {
            const dynamics = new CyclingDynamicsStats();
            dynamics.balance = { left: 50, right: 50 };

            const result = LeftRightBalanceAnalyzer.analyzeFromDynamics(dynamics);

            expect(result).not.toBeNull();
            expect(result.avgLeftPercent).toBe(50);
            expect(result.avgRightPercent).toBe(50);
            expect(result.dominantSide).toBe("balanced");
            expect(result.hasSignificantAsymmetry).toBe(false);
            expect(result.notes.length).toBeGreaterThan(0);
        });

        it("should detect left dominance", () => {
            const dynamics = new CyclingDynamicsStats();
            dynamics.balance = { left: 53, right: 47 };

            const result = LeftRightBalanceAnalyzer.analyzeFromDynamics(dynamics);

            expect(result).not.toBeNull();
            expect(result.dominantSide).toBe("left");
            expect(result.avgLeftPercent).toBe(53);
        });

        it("should detect right dominance", () => {
            const dynamics = new CyclingDynamicsStats();
            dynamics.balance = { left: 46, right: 54 };

            const result = LeftRightBalanceAnalyzer.analyzeFromDynamics(dynamics);

            expect(result).not.toBeNull();
            expect(result.dominantSide).toBe("right");
        });

        it("should detect significant asymmetry", () => {
            const dynamics = new CyclingDynamicsStats();
            dynamics.balance = { left: 56, right: 44 };

            const result = LeftRightBalanceAnalyzer.analyzeFromDynamics(dynamics);

            expect(result).not.toBeNull();
            expect(result.hasSignificantAsymmetry).toBe(true);
            expect(result.notes.some(n => n.toLowerCase().includes("asymmetry"))).toBe(true);
        });

        it("should consider 49/51 as balanced (within 2% threshold)", () => {
            const dynamics = new CyclingDynamicsStats();
            dynamics.balance = { left: 49.5, right: 50.5 };

            const result = LeftRightBalanceAnalyzer.analyzeFromDynamics(dynamics);

            expect(result).not.toBeNull();
            expect(result.dominantSide).toBe("balanced");
        });

        it("should return null for nonsensical balance values", () => {
            const dynamics = new CyclingDynamicsStats();
            dynamics.balance = { left: 10, right: 10 }; // sum < 90

            const result = LeftRightBalanceAnalyzer.analyzeFromDynamics(dynamics);
            expect(result).toBeNull();
        });
    });

    describe("analyzeFromStreams", () => {
        /**
         * Helper: generate mock time/power/balance streams.
         */
        function generateStreams(
            durationSeconds: number,
            avgPower: number,
            avgLeftBalance: number,
            balanceNoise: number = 1
        ): { time: number[]; power: number[]; leftBalance: number[] } {
            const time: number[] = [];
            const power: number[] = [];
            const leftBalance: number[] = [];

            for (let t = 0; t < durationSeconds; t++) {
                time.push(t);
                // Power with some variation
                power.push(avgPower + (Math.random() - 0.5) * 40);
                // Balance with noise
                leftBalance.push(avgLeftBalance + (Math.random() - 0.5) * balanceNoise * 2);
            }

            return { time, power, leftBalance };
        }

        it("should return null for empty arrays", () => {
            expect(LeftRightBalanceAnalyzer.analyzeFromStreams([], [], [])).toBeNull();
        });

        it("should return null for mismatched array lengths", () => {
            expect(LeftRightBalanceAnalyzer.analyzeFromStreams([1, 2], [100, 200], [50])).toBeNull();
        });

        it("should return null for too few valid samples", () => {
            // All power below minimum threshold (50W)
            const time = [0, 1, 2, 3, 4];
            const power = [10, 20, 15, 5, 8];
            const balance = [50, 50, 50, 50, 50];

            expect(LeftRightBalanceAnalyzer.analyzeFromStreams(time, power, balance)).toBeNull();
        });

        it("should analyze a balanced ride", () => {
            const { time, power, leftBalance } = generateStreams(600, 200, 50.0, 1);

            const result = LeftRightBalanceAnalyzer.analyzeFromStreams(time, power, leftBalance);

            expect(result).not.toBeNull();
            expect(result.avgLeftPercent).toBeCloseTo(50, 0);
            expect(result.avgRightPercent).toBeCloseTo(50, 0);
            expect(result.intervalData.length).toBeGreaterThan(0);
        });

        it("should detect asymmetry in stream data", () => {
            const { time, power, leftBalance } = generateStreams(600, 200, 56.0, 0.5);

            const result = LeftRightBalanceAnalyzer.analyzeFromStreams(time, power, leftBalance);

            expect(result).not.toBeNull();
            expect(result.hasSignificantAsymmetry).toBe(true);
            expect(result.dominantSide).toBe("left");
            expect(result.avgLeftPercent).toBeGreaterThan(54);
        });

        it("should compute interval data per minute", () => {
            const { time, power, leftBalance } = generateStreams(300, 200, 50.0, 1);

            const result = LeftRightBalanceAnalyzer.analyzeFromStreams(time, power, leftBalance);

            expect(result).not.toBeNull();
            // 300 seconds / 60 second intervals = ~5 intervals
            expect(result.intervalData.length).toBeGreaterThanOrEqual(4);
            expect(result.intervalData.length).toBeLessThanOrEqual(5);

            result.intervalData.forEach(interval => {
                expect(interval.leftPercent).toBeGreaterThan(0);
                expect(interval.rightPercent).toBeGreaterThan(0);
                expect(interval.leftPercent + interval.rightPercent).toBeCloseTo(100, 0);
                expect(interval.avgPower).toBeGreaterThan(0);
            });
        });

        it("should compute consistency score", () => {
            // Consistent ride (low noise)
            const consistentStreams = generateStreams(600, 200, 50.0, 0.5);
            const consistentResult = LeftRightBalanceAnalyzer.analyzeFromStreams(
                consistentStreams.time,
                consistentStreams.power,
                consistentStreams.leftBalance
            );

            // Inconsistent ride (high noise)
            const inconsistentStreams = generateStreams(600, 200, 50.0, 8);
            const inconsistentResult = LeftRightBalanceAnalyzer.analyzeFromStreams(
                inconsistentStreams.time,
                inconsistentStreams.power,
                inconsistentStreams.leftBalance
            );

            expect(consistentResult).not.toBeNull();
            expect(inconsistentResult).not.toBeNull();

            // Higher consistency score for the consistent ride
            expect(consistentResult.consistencyScore).toBeGreaterThan(inconsistentResult.consistencyScore);
        });

        it("should generate contextual notes", () => {
            const { time, power, leftBalance } = generateStreams(600, 200, 53.0, 2);

            const result = LeftRightBalanceAnalyzer.analyzeFromStreams(time, power, leftBalance);

            expect(result).not.toBeNull();
            expect(result.notes.length).toBeGreaterThan(0);
            // Should have notes about balance + variation
            expect(result.notes.length).toBeGreaterThanOrEqual(1);
        });

        it("should apply power-weighted balance", () => {
            // Manual streams: high power at 60% left, low power at 40% left
            // Power-weighted average should be closer to 60%
            const time = [];
            const power = [];
            const leftBalance = [];

            // First 100 seconds: 300W at 60% left
            for (let t = 0; t < 100; t++) {
                time.push(t);
                power.push(300);
                leftBalance.push(60);
            }
            // Next 100 seconds: 100W at 40% left
            for (let t = 100; t < 200; t++) {
                time.push(t);
                power.push(100);
                leftBalance.push(40);
            }

            const result = LeftRightBalanceAnalyzer.analyzeFromStreams(time, power, leftBalance);

            expect(result).not.toBeNull();
            // Power-weighted: (60*300*100 + 40*100*100) / (300*100 + 100*100) = 55%
            expect(result.avgLeftPercent).toBeCloseTo(55, 0);
        });
    });
});
