import _ from "lodash";
import {
  FtpEstimate,
  FtpConfidence,
  FtpTrendPoint,
  PowerDurationPoint,
  DetectedEffort,
  ActivityFtpAnalysis,
  ActivityFtpIndicator,
  ActivityKeyPeak,
  IndicatorTrust,
  CriticalPowerModelParams
} from "../../models/ftp-estimate.model";
import { EffortDetector } from "./effort-detector";
import { PowerDurationModel } from "./power-duration-model";
import { Activity, ActivityFlag, Peak } from "../../models/sync/activity.model";
import { Streams } from "../../models/activity-data/streams.model";

/**
 * FTP Estimator: Derives Functional Threshold Power predictions from regular
 * cycling activities — no dedicated FTP test rides required.
 *
 * Two layers of analysis (per the research framework):
 *
 * **Layer 1 — Per-Activity Indicators** (`estimateFromActivity`):
 *   Produces multiple honest FTP suggestions from a single ride, each with a
 *   trust level and rationale. Methods: 20min×0.95, 60min best, NP-based, CP model.
 *
 * **Layer 2 — Cross-Ride Aggregated PDC** (`estimate` / `estimateFromPeaks` / `computeTrend`):
 *   Aggregates best power-duration points across all rides in a rolling window,
 *   fits a CP model to the athlete's full power-duration curve, and derives a
 *   rolling FTP trend. This is where the CP model is most valid.
 *
 * All processing is post-ride — no real-time recording or modification.
 */
export class FtpEstimator {
  /** Default estimation window: use last 90 days of data */
  public static readonly DEFAULT_WINDOW_DAYS = 90;

  /** Minimum number of qualifying rides to produce a cross-ride estimate */
  private static readonly MIN_QUALIFYING_RIDES = 2;

  /** Minimum efforts needed across all rides for cross-ride estimate */
  private static readonly MIN_TOTAL_EFFORTS = 3;

  /** Minimum ride duration (seconds) for NP-based indicator */
  private static readonly MIN_NP_RIDE_DURATION = 45 * 60; // 45 min

  /** Minimum R² for showing the CP model indicator on a single ride */
  private static readonly MIN_SINGLE_RIDE_R_SQUARED = 0.92;

  /** Standard durations to highlight */
  private static readonly KEY_DURATIONS: Array<{ label: string; seconds: number }> = [
    { label: "1 min", seconds: 60 },
    { label: "5 min", seconds: 300 },
    { label: "10 min", seconds: 600 },
    { label: "20 min", seconds: 1200 },
    { label: "30 min", seconds: 1800 },
    { label: "60 min", seconds: 3600 }
  ];

  // ──────────────────────────────────────────────────────────────────────
  //  Ride Intensity Classification
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Classify the ride intensity from observable ride characteristics.
   *
   * Uses duration, Variability Index, and the ratio of best mid-duration peaks
   * to NP to determine whether this was an endurance, tempo, or threshold ride.
   * This classification gates the trust levels of per-activity FTP indicators.
   */
  private static classifyRideIntensity(activity: Activity): "endurance" | "tempo" | "threshold" {
    const duration = Math.max(activity.stats.movingTime || 0, activity.stats.elapsedTime || 0);
    const durationMinutes = duration / 60;
    const power = activity.stats.power;

    // Compute VI from stored value or derive it
    const vi =
      power.variabilityIndex > 0
        ? power.variabilityIndex
        : power.weighted > 0 && power.avg > 0
        ? power.weighted / power.avg
        : 1.0;

    // Long rides are almost always endurance
    if (durationMinutes > 120) return "endurance";
    // Medium-long rides with moderate variability
    if (durationMinutes > 75 && vi > 1.12) return "endurance";
    // High variability on rides > 1h suggests endurance with bursts
    if (vi > 1.2 && durationMinutes > 60) return "endurance";
    // Short rides with low variability are likely structured threshold efforts
    if (durationMinutes <= 75 && vi < 1.08) return "threshold";

    return "tempo";
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Layer 1 — Per-Activity FTP Indicators
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Analyze a single cycling activity and produce multiple FTP indicator suggestions.
   *
   * **Critical design principle**: On sub-threshold rides (endurance, tempo),
   * all peaks are below the rider's true capacity at each duration. The indicators
   * must account for this by:
   * - Lowering trust levels for endurance/tempo rides
   * - Using the NP × VI formula which naturally scales up for sub-threshold rides
   * - Clearly communicating that lower-intensity rides produce lower-bound estimates
   *
   * @param activity The cycling activity with power stats
   * @param athleteWeight Athlete weight in kg
   * @returns Complete per-activity analysis, or null if no power data
   */
  public static estimateFromActivity(activity: Activity, athleteWeight: number): ActivityFtpAnalysis | null {
    if (!activity?.hasPowerMeter || !activity.stats?.power || activity.stats.power.avg <= 0) {
      return null;
    }

    const power = activity.stats.power;
    const peaks = power.peaks || [];
    const ftpPerKg = (ftp: number) => (athleteWeight > 0 ? _.round(ftp / athleteWeight, 2) : null);
    const np = power.weighted; // Normalized Power
    const movingTime = activity.stats.movingTime || 0;
    const elapsedTime = activity.stats.elapsedTime || 0;
    const rideDuration = Math.max(movingTime, elapsedTime);
    const durationMinutes = rideDuration / 60;

    // Classify ride intensity — this gates trust levels
    const rideIntensity = FtpEstimator.classifyRideIntensity(activity);

    // Compute VI for use in NP formula
    const vi = power.variabilityIndex > 0 ? power.variabilityIndex : np > 0 && power.avg > 0 ? np / power.avg : 1.0;

    const indicators: ActivityFtpIndicator[] = [];

    // ── Indicator 1: Best 20 min × 0.95 ──
    const best20fromPeaks = FtpEstimator.findBestPeakPower(peaks, 1200);
    const best20fromField = power.best20min > 0 ? power.best20min : 0;
    const best20min = Math.max(best20fromPeaks, best20fromField);
    if (best20min > 0) {
      const ftp20 = _.round(best20min * 0.95, 0);

      // Assess if the 20-min segment was a genuine hard effort:
      // Compare best20min to NP — if they're close, the 20-min wasn't
      // special, it was just part of the steady riding
      const peak20toNp = np > 0 ? best20min / np : 1.0;

      let trust: IndicatorTrust;
      let rationale: string;

      if (rideIntensity === "threshold") {
        // Threshold ride: the 20-min block was likely at or near capacity
        trust = peak20toNp > 1.15 ? "high" : "medium";
        rationale =
          peak20toNp > 1.15
            ? "This threshold ride had a strong 20-min effort well above average intensity."
            : "Classic field test formula. On this hard ride, the 20-min block was likely near capacity.";
      } else if (rideIntensity === "tempo") {
        // Tempo: 20-min was moderately hard
        trust = peak20toNp > 1.2 ? "medium" : "low";
        rationale =
          peak20toNp > 1.2
            ? "This ride had a distinct hard 20-min block. Estimate may be reasonable."
            : "This was a moderate-intensity ride — the 20-min peak is likely below your true 20-min capacity.";
      } else {
        // Endurance: 20-min was almost certainly submaximal
        trust = "low";
        rationale =
          "This was an endurance ride — the best 20-min segment was well below your capacity. This is a lower bound, not an FTP estimate.";
      }

      indicators.push({
        method: "best20min",
        label: "Best 20 min × 0.95",
        ftp: ftp20,
        ftpPerKg: ftpPerKg(ftp20),
        trust,
        rationale,
        detail: `Best 20-min avg: ${_.round(best20min, 0)}W`
      });
    }

    // ── Indicator 2: Best 60 min ──
    const best60min = FtpEstimator.findBestPeakPower(peaks, 3600);
    if (best60min > 0) {
      const ftp60 = _.round(best60min, 0);

      let trust: IndicatorTrust;
      let rationale: string;

      if (rideIntensity === "threshold") {
        trust = "high";
        rationale =
          "FTP is the max power you can sustain for 1 hour. This hard ride likely produced a near-maximal 60-min effort.";
      } else if (rideIntensity === "tempo") {
        trust = "low";
        rationale =
          "This ride's pace was below threshold. The best 60-min average is a lower bound — your true 1-hour max is higher.";
      } else {
        trust = "low";
        rationale =
          "This was an endurance ride. The best 60-min average is well below what you could sustain at max effort. This is a floor, not your FTP.";
      }

      indicators.push({
        method: "best60min",
        label: "Best 60 min",
        ftp: ftp60,
        ftpPerKg: ftpPerKg(ftp60),
        trust,
        rationale,
        detail: `Best 60-min avg: ${ftp60}W`
      });
    }

    // ── Indicator 3: NP-based (VI-adjusted) ──
    //
    // Key insight: FTP ≈ NP × VI (= NP² / avgPower)
    //
    // On a perfectly steady threshold ride (VI=1.0), FTP ≈ NP.
    // On a sub-threshold endurance ride with surges (VI=1.2), FTP ≈ NP × 1.2.
    // The VI naturally encodes how far below threshold the overall ride intensity was,
    // because variable sub-threshold riding has a higher VI than steady threshold riding.
    //
    // The VI effect is capped by duration to prevent overestimates from interval sessions:
    //   ≤60 min: cap VI at 1.05 (short rides → probably near threshold → minimal correction)
    //   60-90 min: cap at 1.12
    //   90-120 min: cap at 1.20
    //   >120 min: cap at 1.25
    if (np > 0 && rideDuration >= FtpEstimator.MIN_NP_RIDE_DURATION) {
      let viCap: number;
      if (durationMinutes <= 60) {
        viCap = 1.05;
      } else if (durationMinutes <= 90) {
        viCap = 1.12;
      } else if (durationMinutes <= 120) {
        viCap = 1.2;
      } else {
        viCap = 1.25;
      }

      const effectiveVI = Math.min(vi, viCap);
      const npFtp = _.round(np * effectiveVI, 0);

      // Trust depends on ride intensity and the VI cap's impact
      const wasCapped = vi > viCap;
      let trust: IndicatorTrust;
      let rationale: string;

      if (rideIntensity === "threshold") {
        trust = "high";
        rationale = `Hard ride — NP closely approximates FTP. VI adjustment: ×${_.round(effectiveVI, 2)}.`;
      } else if (rideIntensity === "tempo") {
        trust = "medium";
        rationale = `Tempo ride — NP adjusted by VI (×${_.round(
          effectiveVI,
          2
        )}) to estimate FTP. Moderate confidence since the ride was below threshold.`;
      } else {
        trust = "medium";
        rationale = `Endurance ride — NP adjusted by VI (×${_.round(
          effectiveVI,
          2
        )}) to account for sub-threshold pacing. Most accurate indicator for easy rides.`;
      }

      const detailParts = [`NP: ${_.round(np, 0)}W`, `VI: ${_.round(vi, 2)}`];
      if (wasCapped) detailParts.push(`Effective VI: ${_.round(effectiveVI, 2)}`);
      detailParts.push(`Duration: ${_.round(durationMinutes, 0)} min`);

      indicators.push({
        method: "np_based",
        label: "NP-adjusted",
        ftp: npFtp,
        ftpPerKg: ftpPerKg(npFtp),
        trust,
        rationale,
        detail: detailParts.join(" · ")
      });
    }

    // ── Indicator 4: CP model (single-ride) ──
    // Only show if R² ≥ 0.92 AND peaks span both <300s and >900s.
    // On endurance rides, even perfect R² doesn't mean accurate FTP — the model
    // is fitting submaximal data.
    const cpResult = FtpEstimator.trySingleRideCpModel(peaks, power.best20min, activity, athleteWeight);
    let cpModelParams: CriticalPowerModelParams | null = null;
    if (cpResult) {
      cpModelParams = cpResult.params;
      const ftp = cpResult.ftp;

      let trust: IndicatorTrust;
      let rationale: string;

      if (rideIntensity === "endurance") {
        // High R² on an endurance ride means the model fits well — to submaximal data.
        // The estimate is a lower bound.
        trust = "low";
        rationale = `The CP model fits the data well (R²=${_.round(
          cpResult.params.rSquared,
          3
        )}), but this was an endurance ride — all efforts were below capacity. This is a lower bound.`;
      } else if (rideIntensity === "threshold" && cpResult.params.rSquared >= 0.97) {
        trust = "high";
        rationale = `Strong curve fit (R²=${_.round(
          cpResult.params.rSquared,
          3
        )}) on a hard ride with diverse efforts.`;
      } else if (cpResult.params.rSquared >= FtpEstimator.MIN_SINGLE_RIDE_R_SQUARED) {
        trust = rideIntensity === "threshold" ? "medium" : "low";
        rationale = `Good curve fit (R²=${_.round(cpResult.params.rSquared, 3)}). ${
          rideIntensity === "tempo"
            ? "Tempo ride — estimate may be slightly low."
            : "More varied, hard efforts would improve reliability."
        }`;
      } else {
        trust = "low";
        rationale = `Moderate curve fit (R²=${_.round(
          cpResult.params.rSquared,
          3
        )}). The data may not represent your true capacity.`;
      }

      indicators.push({
        method: "cp_model",
        label: "CP model",
        ftp,
        ftpPerKg: ftpPerKg(ftp),
        trust,
        rationale,
        detail: `CP: ${_.round(cpResult.params.cp, 0)}W · W': ${_.round(
          cpResult.params.wPrime / 1000,
          1
        )} kJ · R²: ${_.round(cpResult.params.rSquared, 3)}`
      });
    }

    // Build key peaks
    const keyPeaks = FtpEstimator.buildKeyPeaks(peaks, power.best20min, athleteWeight);

    // All peaks sorted by duration
    const allPeaks = peaks
      .filter(p => p.result > 0)
      .map(p => ({ durationSeconds: p.range, power: _.round(p.result, 0) }))
      .sort((a, b) => a.durationSeconds - b.durationSeconds);

    // Best indicator: highest trust first, then highest FTP
    const trustRank: Record<IndicatorTrust, number> = { high: 3, medium: 2, low: 1 };
    const bestIndicator =
      indicators.length > 0 ? _.maxBy(indicators, i => trustRank[i.trust] * 1000 + i.ftp) || null : null;

    return {
      indicators,
      bestIndicator,
      keyPeaks,
      allPeaks,
      cpModelParams,
      rideIntensity
    };
  }

  /**
   * Find the best peak power at a given duration from the peaks array.
   */
  private static findBestPeakPower(peaks: Peak[], durationSeconds: number): number {
    const peak = peaks.find(p => p.range === durationSeconds);
    return peak?.result > 0 ? peak.result : 0;
  }

  /**
   * Build key peak display data for standard durations.
   */
  private static buildKeyPeaks(peaks: Peak[], best20min: number, athleteWeight: number): ActivityKeyPeak[] {
    const keyPeaks = FtpEstimator.KEY_DURATIONS.map(({ label, seconds }) => {
      const exact = peaks.find(p => p.range === seconds);
      const power = exact?.result > 0 ? _.round(exact.result, 0) : null;
      const wkg = power && athleteWeight > 0 ? _.round(power / athleteWeight, 2) : null;
      return { label, durationSeconds: seconds, power, wkg };
    });

    // Fill best20min fallback
    if (best20min > 0) {
      const idx = keyPeaks.findIndex(k => k.durationSeconds === 1200 && !k.power);
      if (idx >= 0) {
        keyPeaks[idx].power = _.round(best20min, 0);
        keyPeaks[idx].wkg = athleteWeight > 0 ? _.round(best20min / athleteWeight, 2) : null;
      }
    }

    return keyPeaks;
  }

  /**
   * Attempt to fit a CP model to a single ride's peaks.
   * Only succeeds if:
   * - There are peaks at both short (<300s) and long (>900s) durations
   * - At least 3 data points ≥120s
   * - Model R² ≥ MIN_SINGLE_RIDE_R_SQUARED
   */
  private static trySingleRideCpModel(
    peaks: Peak[],
    best20min: number,
    activity: Activity,
    athleteWeight: number
  ): { params: CriticalPowerModelParams; ftp: number } | null {
    const activityDate =
      typeof activity.startTime === "string" ? activity.startTime : new Date(activity.startTime).toISOString();

    // Build PD points from peaks (≥120s)
    const pdPoints: PowerDurationPoint[] = peaks
      .filter(p => p.range >= 120 && p.result > 0)
      .map(p => ({
        durationSeconds: p.range,
        power: p.result,
        activityDate,
        activityId: activity.id,
        qualityScore: 0.8
      }));

    if (best20min > 0 && !pdPoints.find(p => p.durationSeconds === 1200)) {
      pdPoints.push({
        durationSeconds: 1200,
        power: best20min,
        activityDate,
        activityId: activity.id,
        qualityScore: 0.85
      });
    }

    if (pdPoints.length < 3) return null;

    // Check effort spread: need points at both <300s and >900s
    const hasShort = pdPoints.some(p => p.durationSeconds < 300);
    const hasLong = pdPoints.some(p => p.durationSeconds > 900);
    if (!hasShort || !hasLong) return null;

    const params = PowerDurationModel.fit(pdPoints);
    if (!params) return null;

    // R² gate
    if (params.rSquared < FtpEstimator.MIN_SINGLE_RIDE_R_SQUARED) return null;

    const ftp = PowerDurationModel.deriveFtp(params);
    if (ftp <= 0 || !Number.isFinite(ftp)) return null;

    // Sanity: FTP should be physiologically reasonable
    const wkg = ftp / athleteWeight;
    if (wkg > 8.5 || wkg < 0.5) return null;

    return { params, ftp: _.round(ftp, 0) };
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Layer 2 — Cross-Ride Aggregated Estimation
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Estimate FTP from a collection of cycling activities using raw streams.
   *
   * @param activities All available cycling activities (will be filtered)
   * @param streamsProvider Function to retrieve streams for a given activity
   * @param athleteWeight Athlete weight in kg
   * @param windowDays Number of days to look back for data
   * @param referenceDate Reference date for the estimation window
   * @returns FTP estimate or null if insufficient data
   */
  public static async estimate(
    activities: Activity[],
    streamsProvider: (activityId: string | number) => Promise<Streams | null>,
    athleteWeight: number,
    windowDays: number = FtpEstimator.DEFAULT_WINDOW_DAYS,
    referenceDate?: Date
  ): Promise<FtpEstimate | null> {
    const refDate = referenceDate || new Date();

    // Filter to cycling activities with power in the window
    const cyclingActivities = FtpEstimator.filterCyclingActivities(activities, windowDays, refDate);

    if (cyclingActivities.length < FtpEstimator.MIN_QUALIFYING_RIDES) {
      return null;
    }

    // Extract power-duration points from each activity
    const allPoints: PowerDurationPoint[] = [];
    const contributingActivityIds: (string | number)[] = [];

    for (const activity of cyclingActivities) {
      const points = FtpEstimator.extractPointsFromActivity(activity, athleteWeight);

      // Also try to extract from streams if available (more detailed)
      try {
        const streams = await streamsProvider(activity.id);
        if (streams?.watts?.length > 0 && streams?.time?.length > 0) {
          const streamPoints = FtpEstimator.extractPointsFromStreams(streams, activity, athleteWeight);
          points.push(...streamPoints);
        }
      } catch {
        // Streams unavailable — fall back to peak data only
      }

      if (points.length > 0) {
        allPoints.push(...points);
        contributingActivityIds.push(activity.id);
      }
    }

    if (allPoints.length < FtpEstimator.MIN_TOTAL_EFFORTS) {
      return null;
    }

    // Aggregate best points per duration
    const bestPoints = PowerDurationModel.aggregateBestPoints(allPoints, windowDays, refDate);

    // Fit CP model
    const modelParams = PowerDurationModel.fit(bestPoints);
    if (!modelParams) {
      return null;
    }

    // Derive FTP
    const ftp = PowerDurationModel.deriveFtp(modelParams);
    if (ftp <= 0 || !Number.isFinite(ftp)) {
      return null;
    }

    // Compute confidence
    const confidence = FtpEstimator.computeConfidence(
      bestPoints,
      modelParams,
      contributingActivityIds.length,
      cyclingActivities,
      windowDays,
      refDate,
      athleteWeight,
      ftp
    );

    // Build date range
    const activityDates = cyclingActivities.filter(a => contributingActivityIds.includes(a.id)).map(a => a.startTime);
    const dataWindowStart = _.min(activityDates) || refDate.toISOString();
    const dataWindowEnd = _.max(activityDates) || refDate.toISOString();

    return {
      ftp,
      ftpPerKg: athleteWeight > 0 ? _.round(ftp / athleteWeight, 2) : null,
      estimatedOn: refDate.toISOString(),
      confidence,
      modelParams,
      contributingActivityIds,
      dataWindowStart: typeof dataWindowStart === "string" ? dataWindowStart : new Date(dataWindowStart).toISOString(),
      dataWindowEnd: typeof dataWindowEnd === "string" ? dataWindowEnd : new Date(dataWindowEnd).toISOString(),
      effortCount: bestPoints.length
    };
  }

  /**
   * Estimate FTP synchronously using only pre-computed peak data from activities.
   * This is faster but less precise — uses peaks already stored in activity stats
   * rather than re-analyzing raw streams.
   *
   * Suitable for quick estimates when streams aren't readily available.
   */
  public static estimateFromPeaks(
    activities: Activity[],
    athleteWeight: number,
    windowDays: number = FtpEstimator.DEFAULT_WINDOW_DAYS,
    referenceDate?: Date
  ): FtpEstimate | null {
    const refDate = referenceDate || new Date();
    const cyclingActivities = FtpEstimator.filterCyclingActivities(activities, windowDays, refDate);

    if (cyclingActivities.length < FtpEstimator.MIN_QUALIFYING_RIDES) {
      return null;
    }

    const allPoints: PowerDurationPoint[] = [];
    const contributingActivityIds: (string | number)[] = [];

    for (const activity of cyclingActivities) {
      const points = FtpEstimator.extractPointsFromActivity(activity, athleteWeight);
      if (points.length > 0) {
        allPoints.push(...points);
        contributingActivityIds.push(activity.id);
      }
    }

    if (allPoints.length < FtpEstimator.MIN_TOTAL_EFFORTS) {
      return null;
    }

    const bestPoints = PowerDurationModel.aggregateBestPoints(allPoints, windowDays, refDate);
    const modelParams = PowerDurationModel.fit(bestPoints);
    if (!modelParams) {
      return null;
    }

    const ftp = PowerDurationModel.deriveFtp(modelParams);
    if (ftp <= 0 || !Number.isFinite(ftp)) {
      return null;
    }

    const confidence = FtpEstimator.computeConfidence(
      bestPoints,
      modelParams,
      contributingActivityIds.length,
      cyclingActivities,
      windowDays,
      refDate,
      athleteWeight,
      ftp
    );

    const activityDates = cyclingActivities.filter(a => contributingActivityIds.includes(a.id)).map(a => a.startTime);

    return {
      ftp,
      ftpPerKg: athleteWeight > 0 ? _.round(ftp / athleteWeight, 2) : null,
      estimatedOn: refDate.toISOString(),
      confidence,
      modelParams,
      contributingActivityIds,
      dataWindowStart: _.min(activityDates) || refDate.toISOString(),
      dataWindowEnd: _.max(activityDates) || refDate.toISOString(),
      effortCount: bestPoints.length
    };
  }

  /**
   * Compute the NP-adjusted FTP for a single ride.
   * This is the lightweight version used by the trend computation.
   *
   * Returns null if the ride doesn't qualify (too short, no NP, etc.).
   */
  public static computeNpAdjustedFtp(activity: Activity): number | null {
    if (!activity?.hasPowerMeter || !activity.stats?.power || activity.stats.power.avg <= 0) {
      return null;
    }

    const power = activity.stats.power;
    const np = power.weighted;
    if (!np || np <= 0) return null;

    const movingTime = activity.stats.movingTime || 0;
    const elapsedTime = activity.stats.elapsedTime || 0;
    const rideDuration = Math.max(movingTime, elapsedTime);
    const durationMinutes = rideDuration / 60;

    if (rideDuration < FtpEstimator.MIN_NP_RIDE_DURATION) {
      return null;
    }

    const vi = power.variabilityIndex > 0 ? power.variabilityIndex : np > 0 && power.avg > 0 ? np / power.avg : 1.0;

    let viCap: number;
    if (durationMinutes <= 60) {
      viCap = 1.05;
    } else if (durationMinutes <= 90) {
      viCap = 1.12;
    } else if (durationMinutes <= 120) {
      viCap = 1.2;
    } else {
      viCap = 1.25;
    }

    const effectiveVI = Math.min(vi, viCap);
    return _.round(np * effectiveVI, 0);
  }

  /**
   * Compute an FTP trend over time using per-ride NP-adjusted estimates
   * with exponential smoothing.
   *
   * Instead of fitting a volatile CP model at each window, this:
   * 1. Computes the NP-adjusted FTP for every qualifying ride
   * 2. Applies an exponential weighted moving average (EWMA) for smooth progression
   * 3. Uses ride intensity to weight contributions (threshold > tempo > endurance)
   * 4. Applies inactivity decay so FTP drops during training gaps (~5% per 90 days)
   * 5. Optionally modulates decay by CTL (fitness) changes
   * 6. Optionally excludes indoor trainer rides
   * 7. Uses HR data to modulate ride weight (harder efforts = more reliable estimate)
   *
   * @param activities All activities
   * @param athleteWeight Athlete weight in kg
   * @param windowDays Lookback window for confidence calculation (default: 90 days)
   * @param intervalDays How often to emit a trend point (default: 7 days)
   * @param manualFtps Optional map of date → manual FTP override values
   * @param excludeTrainer Whether to exclude indoor trainer rides
   * @param ctlByDate Optional map of date → CTL (fitness) values for decay modulation
   * @returns Array of FTP trend points
   */
  public static computeTrend(
    activities: Activity[],
    athleteWeight: number,
    windowDays: number = FtpEstimator.DEFAULT_WINDOW_DAYS,
    intervalDays: number = 7,
    manualFtps?: Map<string, number>,
    excludeTrainer: boolean = false,
    ctlByDate?: Map<string, number>
  ): FtpTrendPoint[] {
    // ── Constants ──
    // ~5% loss per 90 days of complete inactivity ≈ 0.057% per day
    const BASE_DECAY_PER_DAY = 0.00057;
    // Grace period: no decay for the first 7 days of a training gap
    const DECAY_GRACE_DAYS = 7;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const alpha = 0.3;

    // ── Filter to qualifying cycling activities with power ──
    const cyclingActivities = activities
      .filter(a => {
        if (!Activity.isRide(a.type) || !a.hasPowerMeter) return false;
        if (!a.stats?.power || a.stats.power.avg <= 0) return false;
        if (
          a.flags &&
          (a.flags.includes(ActivityFlag.POWER_AVG_KG_ABNORMAL) ||
            a.flags.includes(ActivityFlag.POWER_THRESHOLD_ABNORMAL))
        )
          return false;
        // Exclude indoor trainer rides when toggled
        if (excludeTrainer && a.trainer) return false;
        return true;
      })
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

    if (cyclingActivities.length === 0) {
      return [];
    }

    // ── Compute NP-adjusted FTP + weight for each qualifying ride ──
    const rideEstimates: Array<{
      date: string;
      dateMs: number;
      ftp: number;
      intensity: "endurance" | "tempo" | "threshold";
      weight: number;
    }> = [];

    for (const activity of cyclingActivities) {
      const npFtp = FtpEstimator.computeNpAdjustedFtp(activity);
      if (npFtp == null || npFtp <= 0) continue;

      const intensity = FtpEstimator.classifyRideIntensity(activity);

      // Base weight by ride intensity: threshold rides are most reliable
      let weight: number;
      switch (intensity) {
        case "threshold":
          weight = 1.0;
          break;
        case "tempo":
          weight = 0.7;
          break;
        case "endurance":
          weight = 0.5;
          break;
      }

      // HR-based weight modulation: rides at higher %HRmax are more reliable
      const hr = activity.stats?.heartRate;
      if (hr?.avg > 0 && hr?.max > 0) {
        const hrRatio = hr.avg / hr.max;
        // Scale: at 50% HRmax → 0.79x, at 70% → 0.91x, at 85%+ → 1.0x
        const hrModifier = 0.5 + 0.5 * Math.min(hrRatio / 0.85, 1.0);
        weight *= hrModifier;
      }

      rideEstimates.push({
        date: new Date(activity.startTime).toISOString().split("T")[0],
        dateMs: new Date(activity.startTime).getTime(),
        ftp: npFtp,
        intensity,
        weight
      });
    }

    if (rideEstimates.length === 0) {
      return [];
    }

    // ── Helper: compute decay rate between two dates, optionally CTL-modulated ──
    const getDecayRate = (fromDate: string, toDate: string): number => {
      let rate = BASE_DECAY_PER_DAY;
      if (ctlByDate) {
        const ctlFrom = ctlByDate.get(fromDate);
        const ctlTo = ctlByDate.get(toDate);
        if (ctlFrom != null && ctlTo != null && ctlFrom > 0) {
          const ctlDrop = (ctlFrom - ctlTo) / ctlFrom;
          // If CTL dropped >5%, accelerate decay (up to 2x at 20%+ drop)
          if (ctlDrop > 0.05) {
            rate *= 1.0 + Math.min(ctlDrop / 0.2, 1.0);
          }
        }
      }
      return rate;
    };

    // ── EWMA with inactivity decay between rides ──
    let ewma = rideEstimates[0].ftp;
    let lastRideDateMs = rideEstimates[0].dateMs;
    let lastRideDate = rideEstimates[0].date;

    const smoothed: Array<{ date: string; dateMs: number; ftp: number }> = [
      { date: rideEstimates[0].date, dateMs: rideEstimates[0].dateMs, ftp: _.round(ewma, 0) }
    ];

    for (let i = 1; i < rideEstimates.length; i++) {
      const est = rideEstimates[i];

      // Apply inactivity decay since last ride (after grace period)
      const daysSinceLastRide = (est.dateMs - lastRideDateMs) / MS_PER_DAY;
      if (daysSinceLastRide > DECAY_GRACE_DAYS) {
        const decayDays = daysSinceLastRide - DECAY_GRACE_DAYS;
        const decayRate = getDecayRate(lastRideDate, est.date);
        ewma *= Math.pow(1 - decayRate, decayDays);
      }

      // Apply EWMA update with this ride's estimate
      const effectiveAlpha = alpha * est.weight;
      ewma = effectiveAlpha * est.ftp + (1 - effectiveAlpha) * ewma;
      lastRideDateMs = est.dateMs;
      lastRideDate = est.date;

      smoothed.push({
        date: est.date,
        dateMs: est.dateMs,
        ftp: _.round(ewma, 0)
      });
    }

    // ── Build trend points at regular intervals ──
    const firstDateMs = smoothed[0].dateMs;
    const lastSmoothedDateMs = smoothed[smoothed.length - 1].dateMs;
    const lastSmoothedFtp = smoothed[smoothed.length - 1].ftp;
    const lastSmoothedDate = smoothed[smoothed.length - 1].date;

    // Extend up to today so the trend shows recent decay
    const todayMs = Date.now();
    const endMs = Math.max(lastSmoothedDateMs, todayMs);
    const intervalMs = intervalDays * MS_PER_DAY;
    const lookbackMs = windowDays * MS_PER_DAY;
    const trendPoints: FtpTrendPoint[] = [];

    let currentMs = firstDateMs;

    while (currentMs <= endMs) {
      // Find the most recent smoothed estimate at or before this date
      let closest: typeof smoothed[0] | null = null;
      for (let j = smoothed.length - 1; j >= 0; j--) {
        if (smoothed[j].dateMs <= currentMs) {
          closest = smoothed[j];
          break;
        }
      }

      if (!closest) {
        currentMs += intervalMs;
        continue;
      }

      // If we're past the closest ride, apply inactivity decay
      let ftp = closest.ftp;
      const daysSince = (currentMs - closest.dateMs) / MS_PER_DAY;
      if (daysSince > DECAY_GRACE_DAYS) {
        const decayDays = daysSince - DECAY_GRACE_DAYS;
        const dateStr = new Date(currentMs).toISOString().split("T")[0];
        const decayRate = getDecayRate(closest.date, dateStr);
        ftp = _.round(closest.ftp * Math.pow(1 - decayRate, decayDays), 0);
      }

      const dateStr = new Date(currentMs).toISOString().split("T")[0];

      // Count rides in lookback window for confidence
      const ridesInWindow = rideEstimates.filter(
        r => r.dateMs >= currentMs - lookbackMs && r.dateMs <= currentMs
      ).length;

      const rideConfidence = Math.min(ridesInWindow / 10, 1.0);
      const confidence = _.round(rideConfidence * 100, 0);
      const confidenceLabel: "high" | "moderate" | "low" | "insufficient" =
        confidence >= 70 ? "high" : confidence >= 40 ? "moderate" : confidence >= 20 ? "low" : "insufficient";

      trendPoints.push({
        date: dateStr,
        ftp,
        ftpPerKg: athleteWeight > 0 ? _.round(ftp / athleteWeight, 2) : null,
        confidence,
        confidenceLabel,
        manualOverride: manualFtps?.get(dateStr) || null,
        activityCount: ridesInWindow
      });

      currentMs += intervalMs;
    }

    // Always include the most recent data point (today or last ride)
    const finalDateStr = new Date(endMs).toISOString().split("T")[0];
    if (trendPoints.length === 0 || trendPoints[trendPoints.length - 1].date !== finalDateStr) {
      const daysSinceLastRide = (endMs - lastSmoothedDateMs) / MS_PER_DAY;
      let finalFtp = lastSmoothedFtp;
      if (daysSinceLastRide > DECAY_GRACE_DAYS) {
        const decayDays = daysSinceLastRide - DECAY_GRACE_DAYS;
        const decayRate = getDecayRate(lastSmoothedDate, finalDateStr);
        finalFtp = _.round(lastSmoothedFtp * Math.pow(1 - decayRate, decayDays), 0);
      }

      const ridesInWindow = rideEstimates.filter(r => r.dateMs >= endMs - lookbackMs && r.dateMs <= endMs).length;
      const confidence = _.round(Math.min(ridesInWindow / 10, 1.0) * 100, 0);
      const confidenceLabel: "high" | "moderate" | "low" | "insufficient" =
        confidence >= 70 ? "high" : confidence >= 40 ? "moderate" : confidence >= 20 ? "low" : "insufficient";

      trendPoints.push({
        date: finalDateStr,
        ftp: finalFtp,
        ftpPerKg: athleteWeight > 0 ? _.round(finalFtp / athleteWeight, 2) : null,
        confidence,
        confidenceLabel,
        manualOverride: manualFtps?.get(finalDateStr) || null,
        activityCount: ridesInWindow
      });
    }

    return trendPoints;
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Internal helpers — data extraction
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Extract power-duration points from pre-computed activity peaks.
   * Uses the `stats.power.peaks` array that's already computed by ActivityComputer.
   */
  private static extractPointsFromActivity(activity: Activity, athleteWeight: number): PowerDurationPoint[] {
    const peaks = activity.stats?.power?.peaks;
    if (!peaks || peaks.length === 0) {
      return [];
    }

    const points: PowerDurationPoint[] = [];
    const activityDate =
      typeof activity.startTime === "string" ? activity.startTime : new Date(activity.startTime).toISOString();

    for (const peak of peaks) {
      if (peak.result > 0 && peak.range >= 120 && Number.isFinite(peak.result)) {
        // Basic quality score from peak data alone
        const wkg = peak.result / athleteWeight;
        const qualityScore = wkg >= 1.5 && wkg <= 7.0 ? 0.7 : wkg > 7.0 ? 0.3 : 0.5;

        points.push({
          durationSeconds: peak.range,
          power: peak.result,
          activityDate,
          activityId: activity.id,
          qualityScore
        });
      }
    }

    // Also use best20min if available (it's a separate field)
    if (activity.stats?.power?.best20min > 0) {
      const wkg = activity.stats.power.best20min / athleteWeight;
      points.push({
        durationSeconds: 1200,
        power: activity.stats.power.best20min,
        activityDate,
        activityId: activity.id,
        qualityScore: wkg >= 1.5 && wkg <= 7.0 ? 0.8 : 0.5
      });
    }

    return points;
  }

  /**
   * Extract power-duration points from raw activity streams.
   * Uses EffortDetector for intelligent effort detection, then extracts
   * best power at target durations from the detected efforts.
   */
  private static extractPointsFromStreams(
    streams: Streams,
    activity: Activity,
    athleteWeight: number
  ): PowerDurationPoint[] {
    const timeArray = streams.time;
    const powerArray = streams.watts;
    const hrArray = streams.heartrate;
    const cadArray = streams.cadence;

    if (!timeArray || !powerArray || timeArray.length < 30) {
      return [];
    }

    // Detect efforts
    const efforts = EffortDetector.detect(timeArray, powerArray, hrArray, cadArray, athleteWeight);

    const activityDate =
      typeof activity.startTime === "string" ? activity.startTime : new Date(activity.startTime).toISOString();

    // Convert efforts to power-duration points
    const points: PowerDurationPoint[] = efforts
      .filter(e => e.durationSeconds >= 120 && e.avgPower > 0)
      .map(e => ({
        durationSeconds: e.durationSeconds,
        power: e.normalizedPower > 0 ? Math.min(e.avgPower, e.normalizedPower) : e.avgPower,
        activityDate,
        activityId: activity.id,
        qualityScore: e.qualityScore
      }));

    return points;
  }

  /**
   * Filter activities to cycling rides with power data within the estimation window.
   */
  private static filterCyclingActivities(activities: Activity[], windowDays: number, referenceDate: Date): Activity[] {
    const cutoffDate = new Date(referenceDate.getTime() - windowDays * 24 * 60 * 60 * 1000);

    return activities.filter(activity => {
      // Must be a cycling activity
      if (!Activity.isRide(activity.type)) {
        return false;
      }

      // Must have a power meter
      if (!activity.hasPowerMeter) {
        return false;
      }

      // Must have power stats
      if (!activity.stats?.power || activity.stats.power.avg <= 0) {
        return false;
      }

      // Must be within the window
      const activityDate = new Date(activity.startTime);
      if (activityDate < cutoffDate || activityDate > referenceDate) {
        return false;
      }

      // Should not have abnormal power flags
      if (
        activity.flags &&
        (activity.flags.includes(ActivityFlag.POWER_AVG_KG_ABNORMAL) ||
          activity.flags.includes(ActivityFlag.POWER_THRESHOLD_ABNORMAL))
      ) {
        return false;
      }

      return true;
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Confidence scoring
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Compute comprehensive confidence assessment for an FTP estimate.
   */
  private static computeConfidence(
    bestPoints: PowerDurationPoint[],
    modelParams: { cp: number; wPrime: number; rSquared: number; cpStandardError: number },
    contributingRideCount: number,
    cyclingActivities: Activity[],
    windowDays: number,
    referenceDate: Date,
    athleteWeight: number,
    ftp: number
  ): FtpConfidence {
    const tips: string[] = [];

    // 1. Data quantity (0-1)
    let dataQuantity: number;
    if (bestPoints.length >= 10 && contributingRideCount >= 10) {
      dataQuantity = 1.0;
    } else if (bestPoints.length >= 7 && contributingRideCount >= 5) {
      dataQuantity = 0.8;
    } else if (bestPoints.length >= 5) {
      dataQuantity = 0.6;
    } else {
      dataQuantity = 0.3;
      tips.push("Ride more frequently with a power meter to improve estimate accuracy.");
    }

    // 2. Duration coverage (0-1)
    const durationCoverage = PowerDurationModel.evaluateDurationCoverage(bestPoints);
    if (durationCoverage < 0.6) {
      tips.push("Include some longer sustained efforts (10-30 min) in your rides for better FTP estimation.");
    }

    // 3. Recency (0-1)
    const latestPointDate = _.max(bestPoints.map(p => new Date(p.activityDate).getTime())) || 0;
    const daysSinceLatest = (referenceDate.getTime() - latestPointDate) / (24 * 60 * 60 * 1000);
    let recency: number;
    if (daysSinceLatest <= 7) {
      recency = 1.0;
    } else if (daysSinceLatest <= 14) {
      recency = 0.9;
    } else if (daysSinceLatest <= 30) {
      recency = 0.7;
    } else if (daysSinceLatest <= 60) {
      recency = 0.5;
    } else {
      recency = 0.3;
      tips.push("Your recent rides are getting old. Ride with power to keep the estimate current.");
    }

    // 4. Model fit quality (0-1)
    const modelFit = Math.max(0, modelParams.rSquared);
    if (modelFit < 0.85) {
      tips.push(
        "Your power data points don't follow a smooth power-duration curve. More consistent efforts will help."
      );
    }

    // 5. Physiological consistency (0-1)
    const ftpPerKg = ftp / athleteWeight;
    let physiologicalConsistency: number;
    if (ftpPerKg >= 1.5 && ftpPerKg <= 6.5) {
      physiologicalConsistency = 1.0;
    } else if (ftpPerKg > 6.5 && ftpPerKg <= 7.5) {
      physiologicalConsistency = 0.7; // Elite but plausible
    } else if (ftpPerKg > 7.5) {
      physiologicalConsistency = 0.2;
      tips.push("Estimated FTP seems unusually high. Check your power meter calibration.");
    } else {
      physiologicalConsistency = 0.5;
    }

    // Check CP standard error
    if (modelParams.cpStandardError > 20) {
      physiologicalConsistency *= 0.8;
      tips.push("The model uncertainty is high. More data points will improve precision.");
    }

    // Overall score (weighted average, 0-100)
    const overall = _.round(
      (dataQuantity * 0.25 +
        durationCoverage * 0.25 +
        recency * 0.15 +
        modelFit * 0.2 +
        physiologicalConsistency * 0.15) *
        100,
      0
    );

    // Label
    let label: "high" | "moderate" | "low" | "insufficient";
    if (overall >= 75) {
      label = "high";
    } else if (overall >= 50) {
      label = "moderate";
    } else if (overall >= 25) {
      label = "low";
    } else {
      label = "insufficient";
    }

    return {
      overall,
      dataQuantity: _.round(dataQuantity, 2),
      durationCoverage: _.round(durationCoverage, 2),
      recency: _.round(recency, 2),
      modelFit: _.round(modelFit, 4),
      physiologicalConsistency: _.round(physiologicalConsistency, 2),
      label,
      improvementTips: tips
    };
  }
}
