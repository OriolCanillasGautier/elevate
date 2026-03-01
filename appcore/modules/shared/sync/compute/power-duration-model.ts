import _ from "lodash";
import { CriticalPowerModelParams, PowerDurationPoint } from "../../models/ftp-estimate.model";

/**
 * Power-Duration Model: Fits a Critical Power (CP) model to observed
 * best power-duration data points.
 *
 * The 2-parameter CP model:
 *   P(t) = CP + W' / t
 *
 * Where:
 *   P(t) = power at duration t (seconds)
 *   CP = Critical Power (watts) — the asymptotic power that can theoretically be sustained indefinitely
 *   W' = Anaerobic Work Capacity (joules) — the finite work capacity above CP
 *
 * For FTP estimation, we use CP as the primary predictor. Research shows CP is typically
 * ~5-8% above true FTP (60-min power), so we apply a correction factor.
 *
 * The model is fitted using weighted least-squares regression on the linearized form:
 *   Work(t) = W' + CP * t
 * where Work(t) = P(t) * t (total work in joules).
 */
export class PowerDurationModel {
  /** CP is typically ~5% above 60-minute power (FTP). Apply this correction. */
  private static readonly CP_TO_FTP_FACTOR = 0.95;

  /** Minimum data points required for a meaningful fit */
  private static readonly MIN_DATA_POINTS = 3;

  /** Minimum duration (seconds) for points used in CP model fitting */
  private static readonly MIN_FITTING_DURATION = 120; // 2 minutes

  /** Maximum duration (seconds) for points used in CP model fitting */
  private static readonly MAX_FITTING_DURATION = 3600; // 60 minutes

  /** Duration range that must be partially covered for confidence */
  private static readonly CRITICAL_RANGE_START = 180; // 3 min
  private static readonly CRITICAL_RANGE_END = 1800; // 30 min

  /**
   * Fit a CP model to the given power-duration data points.
   *
   * Uses the linearized form: Work(t) = W' + CP * t
   * Solved via weighted least-squares regression where longer durations get higher weight.
   *
   * @param points Power-duration data points
   * @returns Fitted model parameters, or null if insufficient data
   */
  public static fit(points: PowerDurationPoint[]): CriticalPowerModelParams | null {
    // Filter to valid points within fitting duration range
    const validPoints = points.filter(
      p =>
        p.durationSeconds >= PowerDurationModel.MIN_FITTING_DURATION &&
        p.durationSeconds <= PowerDurationModel.MAX_FITTING_DURATION &&
        p.power > 0 &&
        Number.isFinite(p.power)
    );

    if (validPoints.length < PowerDurationModel.MIN_DATA_POINTS) {
      return null;
    }

    // Use best power at each unique duration (in case of duplicates from different activities)
    const bestByDuration = PowerDurationModel.selectBestPointsPerDuration(validPoints);

    if (bestByDuration.length < PowerDurationModel.MIN_DATA_POINTS) {
      return null;
    }

    // Linearize: Work(t) = P(t) * t = W' + CP * t
    // y = work, x = duration
    // y = intercept + slope * x  →  W' = intercept, CP = slope
    const xs = bestByDuration.map(p => p.durationSeconds);
    const ys = bestByDuration.map(p => p.power * p.durationSeconds);

    // Weights: longer durations more important for FTP estimation.
    // Use sqrt(duration) as weight — balances short and long efforts.
    const weights = bestByDuration.map(p => Math.sqrt(p.durationSeconds) * p.qualityScore);

    const { slope, intercept, rSquared, slopeStdError } = PowerDurationModel.weightedLinearRegression(
      xs,
      ys,
      weights
    );

    // CP = slope, W' = intercept
    const cp = slope;
    const wPrime = intercept;

    // Sanity checks
    if (cp <= 0 || !Number.isFinite(cp)) {
      return null;
    }

    // W' should be positive (represents anaerobic capacity)
    // Clamp to 0 if slightly negative due to fitting noise
    const wPrimeClamped = Math.max(0, wPrime);

    return {
      cp: _.round(cp, 1),
      wPrime: _.round(wPrimeClamped, 0),
      rSquared: _.round(Math.max(0, Math.min(1, rSquared)), 4),
      cpStandardError: _.round(slopeStdError, 1)
    };
  }

  /**
   * Derive FTP estimate from fitted CP model parameters.
   *
   * FTP ≈ CP × 0.95 (standard correction factor, as CP slightly overestimates
   * 60-minute sustainable power).
   *
   * Alternative: use the model to predict power at 60 minutes directly:
   *   P(3600) = CP + W'/3600
   * We take the lower of the two estimates for conservatism.
   */
  public static deriveFtp(params: CriticalPowerModelParams): number {
    // Method 1: CP × correction factor
    const ftpFromCorrection = params.cp * PowerDurationModel.CP_TO_FTP_FACTOR;

    // Method 2: Model prediction at 60 minutes
    const ftpFromModel = params.cp + params.wPrime / 3600;

    // Use the more conservative estimate
    const ftp = Math.min(ftpFromCorrection, ftpFromModel);

    return _.round(ftp, 0);
  }

  /**
   * Predict power at a given duration using the CP model.
   */
  public static predictPower(params: CriticalPowerModelParams, durationSeconds: number): number {
    if (durationSeconds <= 0) {
      return Infinity;
    }
    return params.cp + params.wPrime / durationSeconds;
  }

  /**
   * Generate a full predicted power-duration curve from the model.
   * Useful for visualization.
   *
   * @param params Fitted CP model
   * @param durations Array of durations (seconds) at which to predict power
   * @returns Array of { duration, power } pairs
   */
  public static generateCurve(
    params: CriticalPowerModelParams,
    durations?: number[]
  ): { duration: number; power: number }[] {
    const defaultDurations = [
      1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 420, 480, 600, 720, 900, 1200, 1500, 1800, 2400,
      3000, 3600
    ];
    const durs = durations || defaultDurations;

    return durs.map(d => ({
      duration: d,
      power: _.round(PowerDurationModel.predictPower(params, d), 1)
    }));
  }

  /**
   * Aggregate power-duration points from multiple activities.
   * For each unique duration, keeps only the best (highest power) point.
   * Optionally applies a recency window to prioritize recent data.
   *
   * @param allPoints All power-duration points from all activities
   * @param recencyDays Only consider points from the last N days (0 = no limit)
   * @param referenceDate Reference date for recency calculation
   * @returns Best points for curve fitting
   */
  public static aggregateBestPoints(
    allPoints: PowerDurationPoint[],
    recencyDays: number = 90,
    referenceDate?: Date
  ): PowerDurationPoint[] {
    const refDate = referenceDate || new Date();
    let filteredPoints = allPoints;

    if (recencyDays > 0) {
      const cutoffDate = new Date(refDate.getTime() - recencyDays * 24 * 60 * 60 * 1000);
      filteredPoints = allPoints.filter(p => new Date(p.activityDate) >= cutoffDate);
    }

    return PowerDurationModel.selectBestPointsPerDuration(filteredPoints);
  }

  /**
   * Select the best (highest quality-weighted power) point at each unique duration.
   */
  private static selectBestPointsPerDuration(points: PowerDurationPoint[]): PowerDurationPoint[] {
    const byDuration = _.groupBy(points, p => p.durationSeconds);
    return Object.values(byDuration).map(group => {
      // Rank by power * qualityScore to favor high-quality high-power points
      return _.maxBy(group, p => p.power * (0.5 + 0.5 * p.qualityScore));
    });
  }

  /**
   * Weighted least-squares linear regression.
   * Fits y = intercept + slope * x with per-point weights.
   *
   * Returns slope, intercept, R², and standard error of the slope.
   */
  private static weightedLinearRegression(
    xs: number[],
    ys: number[],
    weights: number[]
  ): { slope: number; intercept: number; rSquared: number; slopeStdError: number } {
    const n = xs.length;

    if (n < 2) {
      return { slope: 0, intercept: 0, rSquared: 0, slopeStdError: Infinity };
    }

    // Normalize weights
    const wSum = _.sum(weights);
    const w = weights.map(wi => (wi / wSum) * n);

    // Weighted means
    const wMeanX = _.sum(xs.map((x, i) => w[i] * x)) / _.sum(w);
    const wMeanY = _.sum(ys.map((y, i) => w[i] * y)) / _.sum(w);

    // Weighted covariance and variance
    let sxx = 0;
    let sxy = 0;
    let syy = 0;

    for (let i = 0; i < n; i++) {
      const dx = xs[i] - wMeanX;
      const dy = ys[i] - wMeanY;
      sxx += w[i] * dx * dx;
      sxy += w[i] * dx * dy;
      syy += w[i] * dy * dy;
    }

    const slope = sxx > 0 ? sxy / sxx : 0;
    const intercept = wMeanY - slope * wMeanX;

    // R² = 1 - SS_res / SS_tot
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < n; i++) {
      const predicted = intercept + slope * xs[i];
      ssRes += w[i] * Math.pow(ys[i] - predicted, 2);
      ssTot += w[i] * Math.pow(ys[i] - wMeanY, 2);
    }
    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    // Standard error of slope
    const mse = n > 2 ? ssRes / (n - 2) : 0;
    const slopeStdError = sxx > 0 ? Math.sqrt(mse / sxx) : Infinity;

    return { slope, intercept, rSquared, slopeStdError };
  }

  /**
   * Evaluate how well the duration range is covered.
   * Returns a coverage score 0-1 based on whether key duration bins have data.
   */
  public static evaluateDurationCoverage(points: PowerDurationPoint[]): number {
    // Define bins: [2-5min], [5-10min], [10-20min], [20-40min], [40-60min]
    const bins: [number, number][] = [
      [120, 300],
      [300, 600],
      [600, 1200],
      [1200, 2400],
      [2400, 3600]
    ];

    let coveredBins = 0;
    for (const [lo, hi] of bins) {
      if (points.some(p => p.durationSeconds >= lo && p.durationSeconds <= hi)) {
        coveredBins++;
      }
    }

    return coveredBins / bins.length;
  }
}
