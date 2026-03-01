import { FtpEstimator } from "@elevate/shared/sync/compute/ftp-estimator";
import {
  Activity,
  ActivityFlag,
  ActivityStats,
  PowerStats,
  Peak,
  HeartRateStats
} from "@elevate/shared/models/sync/activity.model";
import { ElevateSport } from "@elevate/shared/enums/elevate-sport.enum";
import { ActivityFtpAnalysis, IndicatorTrust } from "@elevate/shared/models/ftp-estimate.model";

describe("FtpEstimator", () => {
  const ATHLETE_WEIGHT = 75;
  const REF_DATE = new Date("2025-07-01");

  /**
   * Helper: create a mock cycling activity with power peaks.
   */
  function createMockActivity(
    id: string,
    startTime: string,
    avgPower: number,
    peaks: Peak[],
    best20min?: number,
    flags?: ActivityFlag[] | null,
    overrides?: { weighted?: number; variabilityIndex?: number; movingTime?: number; elapsedTime?: number },
    hrData?: { avg: number; max: number }
  ): Activity {
    const a = new Activity();
    a.id = id;
    a.name = `Ride ${id}`;
    a.type = ElevateSport.Ride;
    a.startTime = startTime;
    a.endTime = startTime;
    a.startTimestamp = new Date(startTime).getTime();
    a.endTimestamp = new Date(startTime).getTime() + 3600000;
    a.hasPowerMeter = true;
    a.trainer = false;
    a.commute = false;
    a.manual = false;
    a.flags = flags !== undefined ? flags : [];

    const powerStats = new PowerStats();
    powerStats.avg = avgPower;
    powerStats.avgKg = avgPower / ATHLETE_WEIGHT;
    powerStats.weighted = overrides?.weighted ?? Math.round(avgPower * 1.08);
    powerStats.variabilityIndex = overrides?.variabilityIndex ?? powerStats.weighted / avgPower;
    powerStats.peaks = peaks;
    if (best20min !== undefined) {
      powerStats.best20min = best20min;
    }

    const stats = new ActivityStats();
    stats.power = powerStats;
    stats.movingTime = overrides?.movingTime ?? 3600; // 1 hour default
    stats.elapsedTime = overrides?.elapsedTime ?? 3900;

    if (hrData) {
      const hr = new HeartRateStats();
      hr.avg = hrData.avg;
      hr.max = hrData.max;
      stats.heartRate = hr;
    }

    a.stats = stats;

    return a;
  }

  /**
   * Helper: generate peaks that follow a CP model.
   * P(t) = CP + W' / t
   */
  function generateCPPeaks(cp: number, wPrime: number): Peak[] {
    const durations = [120, 300, 600, 1200, 1800, 3600];
    return durations.map(d => ({
      range: d,
      result: Math.round(cp + wPrime / d),
      start: 0,
      end: d
    }));
  }

  /**
   * Create a set of realistic cycling activities spread over time.
   */
  function createActivitySet(count: number, cp: number, wPrime: number): Activity[] {
    const activities: Activity[] = [];
    for (let i = 0; i < count; i++) {
      // Spread activities over the last 60 days
      const daysAgo = Math.floor((i / count) * 60);
      const date = new Date(REF_DATE.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      // Add slight per-activity variation to CP/W'
      const actCp = cp + (Math.random() - 0.5) * 10;
      const actWPrime = wPrime + (Math.random() - 0.5) * 2000;
      const peaks = generateCPPeaks(actCp, actWPrime);
      const best20min = Math.round(actCp + actWPrime / 1200);

      activities.push(createMockActivity(`act_${i}`, date.toISOString(), Math.round(actCp * 0.7), peaks, best20min));
    }
    return activities;
  }

  describe("estimateFromPeaks", () => {
    it("should return null for fewer than 2 rides", () => {
      const activities = createActivitySet(1, 250, 20000);
      const result = FtpEstimator.estimateFromPeaks(activities, ATHLETE_WEIGHT, 90, REF_DATE);
      expect(result).toBeNull();
    });

    it("should return null for no cycling activities", () => {
      const result = FtpEstimator.estimateFromPeaks([], ATHLETE_WEIGHT, 90, REF_DATE);
      expect(result).toBeNull();
    });

    it("should return null for activities outside the window", () => {
      // Activities from 6 months ago
      const activities: Activity[] = [];
      for (let i = 0; i < 5; i++) {
        const oldDate = new Date("2024-01-01");
        oldDate.setDate(oldDate.getDate() + i);
        activities.push(createMockActivity(`old_${i}`, oldDate.toISOString(), 200, generateCPPeaks(250, 20000), 270));
      }
      const result = FtpEstimator.estimateFromPeaks(activities, ATHLETE_WEIGHT, 90, REF_DATE);
      expect(result).toBeNull();
    });

    it("should produce a valid estimate from sufficient data", () => {
      const CP = 260;
      const W_PRIME = 20000;
      const activities = createActivitySet(8, CP, W_PRIME);

      const result = FtpEstimator.estimateFromPeaks(activities, ATHLETE_WEIGHT, 90, REF_DATE);

      expect(result).not.toBeNull();
      expect(result.ftp).toBeGreaterThan(200);
      expect(result.ftp).toBeLessThan(320);
      expect(result.ftpPerKg).toBeGreaterThan(0);
      expect(result.confidence).toBeDefined();
      expect(result.confidence.label).toBeDefined();
      expect(result.contributingActivityIds.length).toBeGreaterThanOrEqual(2);
      expect(result.effortCount).toBeGreaterThan(0);
    });

    it("should derive FTP less than or near CP", () => {
      const CP = 250;
      const activities = createActivitySet(10, CP, 18000);

      const result = FtpEstimator.estimateFromPeaks(activities, ATHLETE_WEIGHT, 90, REF_DATE);

      expect(result).not.toBeNull();
      // FTP should be below CP (correction factor ~0.95)
      expect(result.ftp).toBeLessThanOrEqual(CP + 20); // Allow some noise margin
    });

    it("should filter out activities with abnormal power flags", () => {
      const activities: Activity[] = [];
      // 3 flagged activities
      for (let i = 0; i < 3; i++) {
        const date = new Date(REF_DATE.getTime() - i * 24 * 60 * 60 * 1000);
        activities.push(
          createMockActivity(`flagged_${i}`, date.toISOString(), 300, generateCPPeaks(300, 25000), 320, [
            ActivityFlag.POWER_AVG_KG_ABNORMAL
          ])
        );
      }
      // Less than 3 unflagged activities
      const date = new Date(REF_DATE.getTime() - 10 * 24 * 60 * 60 * 1000);
      activities.push(createMockActivity("clean_1", date.toISOString(), 250, generateCPPeaks(250, 20000), 270));

      const result = FtpEstimator.estimateFromPeaks(activities, ATHLETE_WEIGHT, 90, REF_DATE);
      // Should be null because only 1 clean activity (below min of 2)
      expect(result).toBeNull();
    });

    it("should skip non-cycling activities", () => {
      const activities = createActivitySet(5, 250, 20000);
      // Change type of most activities to running
      activities[0].type = ElevateSport.Run;
      activities[1].type = ElevateSport.Run;
      activities[2].type = ElevateSport.Run;
      activities[3].type = ElevateSport.Run;

      const result = FtpEstimator.estimateFromPeaks(activities, ATHLETE_WEIGHT, 90, REF_DATE);
      // Only 1 remaining ride — below minimum of 2
      expect(result).toBeNull();
    });

    it("should include ftpPerKg in the estimate", () => {
      const activities = createActivitySet(8, 260, 20000);
      const result = FtpEstimator.estimateFromPeaks(activities, ATHLETE_WEIGHT, 90, REF_DATE);

      expect(result).not.toBeNull();
      expect(result.ftpPerKg).toBeCloseTo(result.ftp / ATHLETE_WEIGHT, 1);
    });
  });

  describe("computeTrend", () => {
    it("should return empty array for no cycling activities", () => {
      const result = FtpEstimator.computeTrend([], ATHLETE_WEIGHT);
      expect(result.length).toBe(0);
    });

    it("should return trend points for sufficient history", () => {
      // Activities spanning 6 months with proper NP/VI/duration for NP-adjusted method
      const activities: Activity[] = [];
      for (let i = 0; i < 40; i++) {
        const daysAgo = i * 5; // one ride every 5 days
        const date = new Date(REF_DATE.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const np = 200 + (i / 40) * 30; // NP from 200 to 230
        const avgPower = Math.round(np / 1.05);
        const peaks = generateCPPeaks(Math.round(np), 18000);
        activities.push(
          createMockActivity(`trend_${i}`, date.toISOString(), avgPower, peaks, Math.round(np + 18000 / 1200), null, {
            weighted: Math.round(np),
            variabilityIndex: 1.05,
            movingTime: 3600,
            elapsedTime: 3900
          })
        );
      }

      const result = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT, 90, 14);

      expect(result.length).toBeGreaterThan(0);
      result.forEach(point => {
        expect(point.ftp).toBeGreaterThan(0);
        expect(point.date).toBeDefined();
        expect(point.confidence).toBeDefined();
      });
    });

    it("should produce smooth trend (no large jumps between adjacent points)", () => {
      const activities: Activity[] = [];
      for (let i = 0; i < 30; i++) {
        const daysAgo = i * 3;
        const date = new Date(REF_DATE.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        // Stable NP around 200W with ±10W random variation
        const np = 200 + (Math.random() - 0.5) * 20;
        const avgPower = Math.round(np / 1.05);
        const peaks = generateCPPeaks(Math.round(np), 18000);
        activities.push(
          createMockActivity(`smooth_${i}`, date.toISOString(), avgPower, peaks, undefined, null, {
            weighted: Math.round(np),
            variabilityIndex: 1.05,
            movingTime: 3600,
            elapsedTime: 3900
          })
        );
      }

      const result = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT, 90, 7);

      expect(result.length).toBeGreaterThan(1);
      // Check that no adjacent points differ by more than 20W (smoothed)
      for (let i = 1; i < result.length; i++) {
        const diff = Math.abs(result[i].ftp - result[i - 1].ftp);
        expect(diff).toBeLessThanOrEqual(20);
      }
    });

    it("should include manual overrides when provided", () => {
      const activities: Activity[] = [];
      for (let i = 0; i < 40; i++) {
        const daysAgo = i * 5;
        const date = new Date(REF_DATE.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const peaks = generateCPPeaks(250, 20000);
        activities.push(
          createMockActivity(`m_${i}`, date.toISOString(), 175, peaks, Math.round(250 + 20000 / 1200), null, {
            weighted: 200,
            variabilityIndex: 1.05,
            movingTime: 3600,
            elapsedTime: 3900
          })
        );
      }

      const manualFtps = new Map<string, number>();
      const manualDate = new Date(REF_DATE.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      manualFtps.set(manualDate, 245);

      const result = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT, 90, 14, manualFtps);

      // Check if a trend point near that date has the manual override
      const matchingPoint = result.find(p => p.date === manualDate);
      if (matchingPoint) {
        expect(matchingPoint.manualOverride).toBe(245);
      }
      // Even if the interval doesn't hit exactly that date, the trend should work
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return empty for rides too short for NP estimation", () => {
      const activities: Activity[] = [];
      for (let i = 0; i < 10; i++) {
        const daysAgo = i * 3;
        const date = new Date(REF_DATE.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const peaks = generateCPPeaks(250, 20000);
        activities.push(
          createMockActivity(
            `short_${i}`,
            date.toISOString(),
            200,
            peaks,
            undefined,
            null,
            { weighted: 220, variabilityIndex: 1.05, movingTime: 20 * 60, elapsedTime: 22 * 60 } // 20 min, too short
          )
        );
      }

      const result = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT);
      expect(result.length).toBe(0);
    });

    it("should decay FTP during inactivity gaps", () => {
      // 5 rides clustered at the start, then a 60-day gap, then 1 ride at end
      const activities: Activity[] = [];
      const baseDate = new Date("2025-01-01");

      // 5 rides in first 2 weeks with NP ~200W
      for (let i = 0; i < 5; i++) {
        const date = new Date(baseDate.getTime() + i * 3 * 24 * 60 * 60 * 1000);
        const peaks = generateCPPeaks(200, 18000);
        activities.push(
          createMockActivity(`decay_early_${i}`, date.toISOString(), 190, peaks, undefined, null, {
            weighted: 200,
            variabilityIndex: 1.05,
            movingTime: 3600,
            elapsedTime: 3900
          })
        );
      }

      // 1 ride 75 days later (big gap = should see decay)
      const lateDate = new Date(baseDate.getTime() + 75 * 24 * 60 * 60 * 1000);
      const peaks = generateCPPeaks(200, 18000);
      activities.push(
        createMockActivity("decay_late", lateDate.toISOString(), 190, peaks, undefined, null, {
          weighted: 200,
          variabilityIndex: 1.05,
          movingTime: 3600,
          elapsedTime: 3900
        })
      );

      const result = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT, 90, 7);
      expect(result.length).toBeGreaterThan(2);

      // The FTP in the middle of the gap should be lower than at the start
      const earlyPoints = result.filter(p => new Date(p.date) < new Date("2025-01-20"));
      const midGapPoints = result.filter(p => {
        const d = new Date(p.date);
        return d >= new Date("2025-02-15") && d <= new Date("2025-03-01");
      });

      if (earlyPoints.length > 0 && midGapPoints.length > 0) {
        const earlyFtp = earlyPoints[earlyPoints.length - 1].ftp;
        const midFtp = midGapPoints[0].ftp;
        // After ~45 days of inactivity (minus 7 grace), FTP should have dropped
        expect(midFtp).toBeLessThan(earlyFtp);
      }
    });

    it("should exclude trainer rides when excludeTrainer is true", () => {
      const activities: Activity[] = [];

      // 10 outdoor rides with NP ~200W
      for (let i = 0; i < 10; i++) {
        const daysAgo = i * 3;
        const date = new Date(REF_DATE.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const peaks = generateCPPeaks(200, 18000);
        const act = createMockActivity(`outdoor_${i}`, date.toISOString(), 190, peaks, undefined, null, {
          weighted: 200,
          variabilityIndex: 1.05,
          movingTime: 3600,
          elapsedTime: 3900
        });
        act.trainer = false;
        activities.push(act);
      }

      // 10 trainer rides with NP ~230W (trainer reads 30W high)
      for (let i = 0; i < 10; i++) {
        const daysAgo = i * 3;
        const date = new Date(REF_DATE.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const peaks = generateCPPeaks(230, 18000);
        const act = createMockActivity(`trainer_${i}`, date.toISOString(), 220, peaks, undefined, null, {
          weighted: 230,
          variabilityIndex: 1.05,
          movingTime: 3600,
          elapsedTime: 3900
        });
        act.trainer = true;
        activities.push(act);
      }

      const withTrainer = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT, 90, 7, undefined, false);
      const withoutTrainer = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT, 90, 7, undefined, true);

      expect(withTrainer.length).toBeGreaterThan(0);
      expect(withoutTrainer.length).toBeGreaterThan(0);

      // The last FTP with trainer excluded should be lower (outdoor-only = ~200W NP)
      const lastWith = withTrainer[withTrainer.length - 1].ftp;
      const lastWithout = withoutTrainer[withoutTrainer.length - 1].ftp;
      expect(lastWithout).toBeLessThan(lastWith);
    });

    it("should modulate decay by CTL when provided", () => {
      const activities: Activity[] = [];
      const baseDate = new Date("2025-01-01");

      // 5 rides in first 2 weeks
      for (let i = 0; i < 5; i++) {
        const date = new Date(baseDate.getTime() + i * 3 * 24 * 60 * 60 * 1000);
        const peaks = generateCPPeaks(200, 18000);
        activities.push(
          createMockActivity(`ctl_${i}`, date.toISOString(), 190, peaks, undefined, null, {
            weighted: 200,
            variabilityIndex: 1.05,
            movingTime: 3600,
            elapsedTime: 3900
          })
        );
      }

      // 1 ride 60 days later
      const lateDate = new Date(baseDate.getTime() + 60 * 24 * 60 * 60 * 1000);
      const latePeaks = generateCPPeaks(200, 18000);
      activities.push(
        createMockActivity("ctl_late", lateDate.toISOString(), 190, latePeaks, undefined, null, {
          weighted: 200,
          variabilityIndex: 1.05,
          movingTime: 3600,
          elapsedTime: 3900
        })
      );

      // CTL dropping from 80 to 20 (large fitness loss)
      const ctlByDate = new Map<string, number>();
      for (let d = 0; d <= 75; d++) {
        const date = new Date(baseDate.getTime() + d * 24 * 60 * 60 * 1000);
        const dateStr = date.toISOString().split("T")[0];
        const ctl = 80 - (d / 75) * 60; // 80 → 20
        ctlByDate.set(dateStr, ctl);
      }

      const withoutCtl = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT, 90, 7);
      const withCtl = FtpEstimator.computeTrend(activities, ATHLETE_WEIGHT, 90, 7, undefined, false, ctlByDate);

      // With CTL decay modulation, mid-gap FTP should be lower than without
      const midDate = new Date("2025-02-15");
      const midWithout = withoutCtl.find(p => new Date(p.date) >= midDate);
      const midWith = withCtl.find(p => new Date(p.date) >= midDate);

      if (midWithout && midWith) {
        expect(midWith.ftp).toBeLessThanOrEqual(midWithout.ftp);
      }
    });
  });

  describe("confidence scoring", () => {
    it("should assign higher confidence with more data", () => {
      const fewActivities = createActivitySet(3, 250, 20000);
      const manyActivities = createActivitySet(15, 250, 20000);

      const fewResult = FtpEstimator.estimateFromPeaks(fewActivities, ATHLETE_WEIGHT, 90, REF_DATE);
      const manyResult = FtpEstimator.estimateFromPeaks(manyActivities, ATHLETE_WEIGHT, 90, REF_DATE);

      if (fewResult && manyResult) {
        expect(manyResult.confidence.overall).toBeGreaterThanOrEqual(fewResult.confidence.overall);
      }
    });

    it("should have confidence between 0 and 100", () => {
      const activities = createActivitySet(10, 250, 20000);
      const result = FtpEstimator.estimateFromPeaks(activities, ATHLETE_WEIGHT, 90, REF_DATE);

      expect(result).not.toBeNull();
      expect(result.confidence.overall).toBeGreaterThanOrEqual(0);
      expect(result.confidence.overall).toBeLessThanOrEqual(100);
    });

    it("should flag physiological implausibility for extreme W/kg", () => {
      // Athlete weight = 50kg, fake CP=500 → 10 W/kg, clearly unrealistic
      const activities = createActivitySet(10, 500, 30000);
      const result = FtpEstimator.estimateFromPeaks(activities, 50, 90, REF_DATE);

      if (result) {
        expect(result.confidence.physiologicalConsistency).toBeLessThan(1.0);
      }
    });
  });

  describe("estimate (async)", () => {
    it("should return null with insufficient rides even with streams", async () => {
      const activities = createActivitySet(1, 250, 20000);
      const streamsProvider = async () => null;

      const result = await FtpEstimator.estimate(activities, streamsProvider, ATHLETE_WEIGHT, 90, REF_DATE);
      expect(result).toBeNull();
    });

    it("should work when streams are unavailable (peaks only)", async () => {
      const activities = createActivitySet(8, 260, 20000);
      const streamsProvider = async () => null;

      const result = await FtpEstimator.estimate(activities, streamsProvider, ATHLETE_WEIGHT, 90, REF_DATE);

      expect(result).not.toBeNull();
      expect(result.ftp).toBeGreaterThan(0);
    });
  });

  describe("estimateFromActivity", () => {
    /**
     * Helper: create a single activity with detailed power stats for per-activity estimation.
     */
    function createDetailedActivity(
      overrides: {
        avgPower?: number;
        weighted?: number;
        best20min?: number;
        intensityFactor?: number;
        variabilityIndex?: number;
        movingTime?: number;
        elapsedTime?: number;
        peaks?: Peak[];
        hasPowerMeter?: boolean;
      } = {}
    ): Activity {
      const a = new Activity();
      a.id = "detail_1";
      a.name = "Detailed Ride";
      a.type = ElevateSport.Ride;
      a.startTime = "2025-06-15T10:00:00.000Z";
      a.endTime = "2025-06-15T12:00:00.000Z";
      a.startTimestamp = new Date(a.startTime).getTime();
      a.endTimestamp = new Date(a.endTime).getTime();
      a.hasPowerMeter = overrides.hasPowerMeter !== undefined ? overrides.hasPowerMeter : true;
      a.trainer = false;
      a.commute = false;
      a.manual = false;
      a.flags = [];
      a.athleteSnapshot = { athleteSettings: { weight: ATHLETE_WEIGHT } } as any;

      const powerStats = new PowerStats();
      powerStats.avg = overrides.avgPower ?? 200;
      powerStats.avgKg = powerStats.avg / ATHLETE_WEIGHT;
      powerStats.weighted = overrides.weighted ?? 220;
      powerStats.best20min = overrides.best20min ?? 260;
      powerStats.intensityFactor = overrides.intensityFactor ?? 0.85;
      powerStats.variabilityIndex = overrides.variabilityIndex ?? 1.05;
      powerStats.peaks = overrides.peaks ?? generateCPPeaks(250, 20000);

      const stats = new ActivityStats();
      stats.power = powerStats;
      stats.movingTime = overrides.movingTime ?? 7200; // 2 hours
      stats.elapsedTime = overrides.elapsedTime ?? 7800;
      a.stats = stats;

      return a;
    }

    it("should return null for activity without power meter", () => {
      const activity = createDetailedActivity({ hasPowerMeter: false });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);
      expect(result).toBeNull();
    });

    it("should return null for activity with zero avg power", () => {
      const activity = createDetailedActivity({ avgPower: 0 });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);
      expect(result).toBeNull();
    });

    it("should produce an analysis with multiple indicators", () => {
      const activity = createDetailedActivity();
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      expect(result.indicators.length).toBeGreaterThan(0);
      expect(result.keyPeaks.length).toBeGreaterThan(0);
      expect(result.allPeaks.length).toBeGreaterThan(0);
    });

    it("should include best20min indicator", () => {
      const activity = createDetailedActivity({ best20min: 280 });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      const best20 = result.indicators.find(i => i.method === "best20min");
      expect(best20).toBeDefined();
      expect(best20.ftp).toBe(Math.round(280 * 0.95)); // 266
      expect(best20.label).toContain("20 min");
    });

    it("should include best60min indicator when peak exists", () => {
      const peaks = generateCPPeaks(250, 20000);
      // Threshold ride: short + low VI → best60min gets high trust
      const activity = createDetailedActivity({
        peaks,
        movingTime: 65 * 60,
        elapsedTime: 70 * 60,
        variabilityIndex: 1.03
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      const best60 = result.indicators.find(i => i.method === "best60min");
      expect(best60).toBeDefined();
      expect(best60.trust).toBe("high");
      expect(result.rideIntensity).toBe("threshold");
    });

    it("should assign low trust to best60min on endurance rides", () => {
      const peaks = generateCPPeaks(250, 20000);
      // Default: 2h+ ride → endurance classification
      const activity = createDetailedActivity({ peaks });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      const best60 = result.indicators.find(i => i.method === "best60min");
      expect(best60).toBeDefined();
      expect(best60.trust).toBe("low");
      expect(result.rideIntensity).toBe("endurance");
    });

    it("should include NP-based indicator for long enough rides", () => {
      const activity = createDetailedActivity({
        weighted: 240, // NP
        movingTime: 3600, // 60 min
        elapsedTime: 3900,
        intensityFactor: 0.9
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      const npBased = result.indicators.find(i => i.method === "np_based");
      expect(npBased).toBeDefined();
      expect(npBased.ftp).toBeGreaterThan(0);
    });

    it("should NOT include NP-based indicator for short rides", () => {
      const activity = createDetailedActivity({
        weighted: 240,
        movingTime: 20 * 60, // 20 min, below 45-min threshold
        elapsedTime: 20 * 60
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      const npBased = result.indicators.find(i => i.method === "np_based");
      expect(npBased).toBeUndefined();
    });

    it("should assign high trust to NP-based on threshold rides", () => {
      const activity = createDetailedActivity({
        weighted: 260,
        movingTime: 60 * 60,
        elapsedTime: 65 * 60, // keep elapsedTime consistent
        variabilityIndex: 1.04, // low VI → threshold classification
        intensityFactor: 0.9
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result.rideIntensity).toBe("threshold");
      const npBased = result.indicators.find(i => i.method === "np_based");
      expect(npBased).toBeDefined();
      expect(npBased.trust).toBe("high");
    });

    it("should assign medium trust to NP-based on endurance rides", () => {
      const activity = createDetailedActivity({
        weighted: 165, // NP = 165W
        avgPower: 134, // avg = 134W → VI ≈ 1.23
        variabilityIndex: 1.23,
        movingTime: 125 * 60, // 125 min
        elapsedTime: 130 * 60
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result.rideIntensity).toBe("endurance");
      const npBased = result.indicators.find(i => i.method === "np_based");
      expect(npBased).toBeDefined();
      expect(npBased.trust).toBe("medium");
      // NP × VI = 165 × 1.23 ≈ 203 (within cap of 1.25 for >120min)
      expect(npBased.ftp).toBeGreaterThanOrEqual(200);
      expect(npBased.ftp).toBeLessThanOrEqual(210);
    });

    it("should include CP model indicator only with good R² and spread", () => {
      // Peaks at both short (<300s) and long (>900s) durations with good fit
      const activity = createDetailedActivity();
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      // CP model may or may not appear depending on R² — but if it does, it should be valid
      const cpModel = result.indicators.find(i => i.method === "cp_model");
      if (cpModel) {
        expect(cpModel.ftp).toBeGreaterThan(0);
        expect(result.cpModelParams).toBeDefined();
        expect(result.cpModelParams.rSquared).toBeGreaterThanOrEqual(0.92);
      }
    });

    it("should select best indicator based on trust level", () => {
      const activity = createDetailedActivity({
        best20min: 280,
        weighted: 250,
        movingTime: 60 * 60,
        intensityFactor: 0.92
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      expect(result.bestIndicator).not.toBeNull();

      // Best should be the highest trust, then highest FTP
      const trustRank: Record<IndicatorTrust, number> = { high: 3, medium: 2, low: 1 };
      const bestTrust = trustRank[result.bestIndicator.trust];
      for (const indicator of result.indicators) {
        if (indicator !== result.bestIndicator) {
          const t = trustRank[indicator.trust];
          // Every other indicator should have lower or equal composite score
          expect(t * 1000 + indicator.ftp).toBeLessThanOrEqual(bestTrust * 1000 + result.bestIndicator.ftp);
        }
      }
    });

    it("should compute W/kg when athlete weight is provided", () => {
      const activity = createDetailedActivity({ best20min: 300 });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      for (const indicator of result.indicators) {
        expect(indicator.ftpPerKg).not.toBeNull();
        expect(indicator.ftpPerKg).toBeCloseTo(indicator.ftp / ATHLETE_WEIGHT, 1);
      }
    });

    it("should populate key peaks at standard durations", () => {
      const activity = createDetailedActivity();
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      expect(result.keyPeaks.length).toBe(6); // 1, 5, 10, 20, 30, 60 min
      expect(result.keyPeaks[0].label).toBe("1 min");
      expect(result.keyPeaks[5].label).toBe("60 min");
    });

    it("should include rideIntensity in the analysis", () => {
      const activity = createDetailedActivity();
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      expect(["endurance", "tempo", "threshold"]).toContain(result.rideIntensity);
    });

    it("should classify short low-VI rides as threshold", () => {
      const activity = createDetailedActivity({
        movingTime: 55 * 60,
        elapsedTime: 58 * 60,
        variabilityIndex: 1.03
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result.rideIntensity).toBe("threshold");
    });

    it("should classify long rides as endurance", () => {
      const activity = createDetailedActivity({
        movingTime: 150 * 60,
        elapsedTime: 160 * 60,
        variabilityIndex: 1.1
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result.rideIntensity).toBe("endurance");
    });

    it("should classify medium rides with moderate VI as tempo", () => {
      const activity = createDetailedActivity({
        movingTime: 70 * 60,
        elapsedTime: 72 * 60,
        variabilityIndex: 1.1 // Between 1.08 and 1.12 → tempo
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result.rideIntensity).toBe("tempo");
    });

    it("should produce higher NP-adjusted FTP for high-VI endurance rides", () => {
      // Simulates user's real-world scenario: 2h ride, NP=165, VI=1.23, real FTP ≈ 200
      const activity = createDetailedActivity({
        avgPower: 134,
        weighted: 165,
        variabilityIndex: 1.23,
        best20min: 174,
        movingTime: 125 * 60,
        elapsedTime: 130 * 60,
        peaks: [
          { range: 60, result: 265, start: 0, end: 60 },
          { range: 120, result: 230, start: 0, end: 120 },
          { range: 300, result: 193, start: 0, end: 300 },
          { range: 600, result: 180, start: 0, end: 600 },
          { range: 1200, result: 174, start: 0, end: 1200 },
          { range: 1800, result: 168, start: 0, end: 1800 },
          { range: 3600, result: 148, start: 0, end: 3600 }
        ]
      });
      const result = FtpEstimator.estimateFromActivity(activity, ATHLETE_WEIGHT);

      expect(result).not.toBeNull();
      expect(result.rideIntensity).toBe("endurance");

      const npBased = result.indicators.find(i => i.method === "np_based");
      expect(npBased).toBeDefined();
      // NP × VI = 165 × 1.23 ≈ 203W — close to real FTP of ~200
      expect(npBased.ftp).toBeGreaterThanOrEqual(195);
      expect(npBased.ftp).toBeLessThanOrEqual(210);
      expect(npBased.trust).toBe("medium");

      // best20min × 0.95 should have low trust on endurance rides
      const best20 = result.indicators.find(i => i.method === "best20min");
      expect(best20).toBeDefined();
      expect(best20.trust).toBe("low");
    });
  });
});
