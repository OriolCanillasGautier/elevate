import { PowerDurationModel } from "@elevate/shared/sync/compute/power-duration-model";
import { PowerDurationPoint, CriticalPowerModelParams } from "@elevate/shared/models/ftp-estimate.model";

describe("PowerDurationModel", () => {
    /**
     * Helper: generate realistic power-duration data based on a known CP model.
     * P(t) = CP + W' / t
     */
    function generateKnownPDPoints(
        cp: number,
        wPrime: number,
        durations: number[] = [120, 180, 300, 600, 1200, 1800, 3600]
    ): PowerDurationPoint[] {
        return durations.map(d => ({
            durationSeconds: d,
            power: cp + wPrime / d + (Math.random() - 0.5) * 3, // Small noise
            activityDate: "2025-06-01T10:00:00Z",
            activityId: `activity_${d}`,
            qualityScore: 0.8
        }));
    }

    describe("fit", () => {
        it("should fit a CP model to valid data points", () => {
            // Given: data points generated from CP=250, W'=20000
            const points = generateKnownPDPoints(250, 20000);

            // When
            const result = PowerDurationModel.fit(points);

            // Then
            expect(result).not.toBeNull();
            expect(result.cp).toBeGreaterThan(230);
            expect(result.cp).toBeLessThan(270);
            expect(result.wPrime).toBeGreaterThan(10000);
            expect(result.rSquared).toBeGreaterThan(0.9);
        });

        it("should return null for too few data points", () => {
            // Given
            const points: PowerDurationPoint[] = [
                { durationSeconds: 300, power: 300, activityDate: "2025-06-01", activityId: "1", qualityScore: 0.8 }
            ];

            // When
            const result = PowerDurationModel.fit(points);

            // Then
            expect(result).toBeNull();
        });

        it("should return null for empty input", () => {
            expect(PowerDurationModel.fit([])).toBeNull();
        });

        it("should filter out points below min fitting duration", () => {
            // Given: points all below 2 minutes
            const points: PowerDurationPoint[] = [
                { durationSeconds: 10, power: 500, activityDate: "2025-06-01", activityId: "1", qualityScore: 0.8 },
                { durationSeconds: 30, power: 450, activityDate: "2025-06-01", activityId: "2", qualityScore: 0.8 },
                { durationSeconds: 60, power: 400, activityDate: "2025-06-01", activityId: "3", qualityScore: 0.8 }
            ];

            // When
            const result = PowerDurationModel.fit(points);

            // Then: too few valid points after filtering
            expect(result).toBeNull();
        });

        it("should produce high R² for perfect CP data", () => {
            // Given: exact CP model data (no noise)
            const cp = 260;
            const wPrime = 18000;
            const durations = [120, 180, 300, 600, 1200, 1800, 3600];
            const points = durations.map(d => ({
                durationSeconds: d,
                power: cp + wPrime / d,
                activityDate: "2025-06-01",
                activityId: `act_${d}`,
                qualityScore: 1.0
            }));

            // When
            const result = PowerDurationModel.fit(points);

            // Then
            expect(result).not.toBeNull();
            expect(result.rSquared).toBeGreaterThan(0.99);
            expect(result.cp).toBeCloseTo(cp, 0);
            expect(result.wPrime).toBeCloseTo(wPrime, -2);
        });
    });

    describe("deriveFtp", () => {
        it("should derive FTP from CP model as a conservative estimate", () => {
            // Given
            const params: CriticalPowerModelParams = {
                cp: 260,
                wPrime: 20000,
                rSquared: 0.98,
                cpStandardError: 5
            };

            // When
            const ftp = PowerDurationModel.deriveFtp(params);

            // Then: FTP should be less than CP (correction factor ~0.95)
            expect(ftp).toBeLessThan(params.cp);
            expect(ftp).toBeGreaterThan(params.cp * 0.9);
            expect(ftp).toBeLessThanOrEqual(params.cp * 0.95 + 1);
        });

        it("should return 0-range FTP for 0 W' model", () => {
            // Given
            const params: CriticalPowerModelParams = {
                cp: 200,
                wPrime: 0,
                rSquared: 0.95,
                cpStandardError: 3
            };

            // When
            const ftp = PowerDurationModel.deriveFtp(params);

            // Then: with W'=0, model prediction at 60min = CP + 0/3600 = CP
            // Correction: CP * 0.95 = 190
            expect(ftp).toBe(190);
        });
    });

    describe("predictPower", () => {
        it("should predict higher power at shorter durations", () => {
            // Given
            const params: CriticalPowerModelParams = {
                cp: 250,
                wPrime: 20000,
                rSquared: 0.98,
                cpStandardError: 5
            };

            // When
            const power5min = PowerDurationModel.predictPower(params, 300);
            const power20min = PowerDurationModel.predictPower(params, 1200);
            const power60min = PowerDurationModel.predictPower(params, 3600);

            // Then
            expect(power5min).toBeGreaterThan(power20min);
            expect(power20min).toBeGreaterThan(power60min);
            expect(power60min).toBeCloseTo(params.cp + params.wPrime / 3600, 1);
        });
    });

    describe("generateCurve", () => {
        it("should generate a power-duration curve", () => {
            // Given
            const params: CriticalPowerModelParams = {
                cp: 250,
                wPrime: 20000,
                rSquared: 0.98,
                cpStandardError: 5
            };

            // When
            const curve = PowerDurationModel.generateCurve(params);

            // Then
            expect(curve.length).toBeGreaterThan(0);
            // Should be monotonically decreasing
            for (let i = 1; i < curve.length; i++) {
                expect(curve[i].power).toBeLessThanOrEqual(curve[i - 1].power);
            }
        });
    });

    describe("aggregateBestPoints", () => {
        it("should keep the best point per unique duration", () => {
            // Given: multiple points at the same duration
            const points: PowerDurationPoint[] = [
                { durationSeconds: 300, power: 300, activityDate: "2025-06-01", activityId: "1", qualityScore: 0.8 },
                { durationSeconds: 300, power: 310, activityDate: "2025-06-05", activityId: "2", qualityScore: 0.8 },
                { durationSeconds: 300, power: 290, activityDate: "2025-06-10", activityId: "3", qualityScore: 0.8 },
                { durationSeconds: 600, power: 270, activityDate: "2025-06-01", activityId: "4", qualityScore: 0.8 }
            ];

            // When
            const best = PowerDurationModel.aggregateBestPoints(points, 0);

            // Then: should have 2 unique durations
            expect(best.length).toBe(2);
            const point300 = best.find(p => p.durationSeconds === 300);
            expect(point300.power).toBe(310); // Highest power at 300s
        });

        it("should filter by recency window", () => {
            // Given
            const refDate = new Date("2025-07-01");
            const points: PowerDurationPoint[] = [
                { durationSeconds: 300, power: 350, activityDate: "2025-01-01", activityId: "1", qualityScore: 0.8 },
                { durationSeconds: 300, power: 280, activityDate: "2025-06-15", activityId: "2", qualityScore: 0.8 }
            ];

            // When: 30-day window from July 1
            const best = PowerDurationModel.aggregateBestPoints(points, 30, refDate);

            // Then: only the June point should survive
            expect(best.length).toBe(1);
            expect(best[0].power).toBe(280);
        });
    });

    describe("evaluateDurationCoverage", () => {
        it("should return 1.0 for full coverage", () => {
            // Given: points covering all 5 bins
            const points: PowerDurationPoint[] = [
                { durationSeconds: 180, power: 300, activityDate: "2025-06-01", activityId: "1", qualityScore: 0.8 },
                { durationSeconds: 400, power: 280, activityDate: "2025-06-01", activityId: "2", qualityScore: 0.8 },
                { durationSeconds: 800, power: 260, activityDate: "2025-06-01", activityId: "3", qualityScore: 0.8 },
                { durationSeconds: 1500, power: 240, activityDate: "2025-06-01", activityId: "4", qualityScore: 0.8 },
                { durationSeconds: 3000, power: 220, activityDate: "2025-06-01", activityId: "5", qualityScore: 0.8 }
            ];

            // When
            const coverage = PowerDurationModel.evaluateDurationCoverage(points);

            // Then
            expect(coverage).toBe(1.0);
        });

        it("should return 0.0 for no coverage", () => {
            expect(PowerDurationModel.evaluateDurationCoverage([])).toBe(0);
        });

        it("should return partial coverage", () => {
            // Given: only 2 of 5 bins covered
            const points: PowerDurationPoint[] = [
                { durationSeconds: 200, power: 300, activityDate: "2025-06-01", activityId: "1", qualityScore: 0.8 },
                { durationSeconds: 500, power: 280, activityDate: "2025-06-01", activityId: "2", qualityScore: 0.8 }
            ];

            // When
            const coverage = PowerDurationModel.evaluateDurationCoverage(points);

            // Then
            expect(coverage).toBe(0.4); // 2 of 5 bins
        });
    });
});
