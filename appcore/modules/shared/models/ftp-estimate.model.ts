/**
 * Models for the intelligent FTP (Functional Threshold Power) estimation system.
 *
 * The system derives FTP predictions from regular cycling activities—
 * without requiring dedicated FTP test rides. All processing occurs post-ride
 * during data analysis.
 *
 * Architecture (per the research framework):
 *
 * Layer 1 — Per-activity FTP *indicators* (multiple honest methods, each with trust level)
 * Layer 2 — Cross-ride aggregated Power-Duration Curve → rolling FTP trend
 * Layer 3 — Confidence scoring with physiological validation (VI, HR coupling, cadence stability)
 */

// ────────────────────────────────────────────────────────────────────────────
//  Effort Detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Represents a single detected effort within a ride.
 * An effort is a sustained period of meaningful power output,
 * identified automatically from the ride data using multi-signal validation.
 */
export interface DetectedEffort {
  /** Start index into the streams arrays */
  startIndex: number;

  /** End index into the streams arrays */
  endIndex: number;

  /** Duration of the effort in seconds */
  durationSeconds: number;

  /** Average power for the effort in watts */
  avgPower: number;

  /** Normalized power for the effort in watts */
  normalizedPower: number;

  /** Variability index (NP / avg power) — lower means steadier */
  variabilityIndex: number;

  /** Average heart rate during the effort (null if unavailable) */
  avgHeartRate: number | null;

  /** Heart rate drift coefficient during the effort (null if unavailable).
   *  Positive values indicate cardiac drift (decoupling). */
  heartRateDrift: number | null;

  /** Average cadence during the effort (null if unavailable) */
  avgCadence: number | null;

  /** Cadence coefficient of variation 0-1 (lower = more stable) */
  cadenceCV: number | null;

  /** Whether HR response correlates with power (multi-signal validation) */
  hrPowerCoupled: boolean | null;

  /** Quality score 0-1 indicating how reliable this effort is for FTP estimation.
   *  Based on steadiness, HR response, duration, power consistency, and cadence stability. */
  qualityScore: number;
}

// ────────────────────────────────────────────────────────────────────────────
//  Power-Duration Curve
// ────────────────────────────────────────────────────────────────────────────

/**
 * A point on the power-duration curve: the best average power
 * sustained for a given duration.
 */
export interface PowerDurationPoint {
  /** Duration in seconds */
  durationSeconds: number;

  /** Best average power at this duration in watts */
  power: number;

  /** Date of the activity this point came from */
  activityDate: string;

  /** Activity ID that produced this point */
  activityId: string | number;

  /** Quality score of the effort (0-1) */
  qualityScore: number;
}

/**
 * Fitted parameters from a Critical Power model.
 *
 * The 2-parameter CP model: P(t) = CP + W' / t
 * where:
 *   P(t) = power at duration t
 *   CP   = critical power (asymptote, approximately FTP)
 *   W'   = anaerobic work capacity (joules above CP)
 */
export interface CriticalPowerModelParams {
  /** Critical Power in watts — the power asymptote */
  cp: number;

  /** W' (W-prime) in joules — anaerobic work capacity above CP */
  wPrime: number;

  /** R² goodness of fit (0-1) */
  rSquared: number;

  /** Standard error of the CP estimate in watts */
  cpStandardError: number;
}

// ────────────────────────────────────────────────────────────────────────────
//  Confidence & Validation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Confidence breakdown for an FTP estimate.
 */
export interface FtpConfidence {
  /** Overall confidence score 0-100 */
  overall: number;

  /** Data quantity factor 0-1: how many data points contribute */
  dataQuantity: number;

  /** Duration coverage factor 0-1: how well different time ranges are covered */
  durationCoverage: number;

  /** Data recency factor 0-1: how recent the contributing data is */
  recency: number;

  /** Model fit quality 0-1: how well the CP model fits the data */
  modelFit: number;

  /** Physiological consistency 0-1: does the estimate make physiological sense */
  physiologicalConsistency: number;

  /** Textual description of the confidence level */
  label: "high" | "moderate" | "low" | "insufficient";

  /** User-facing guidance to improve estimate quality */
  improvementTips: string[];
}

// ────────────────────────────────────────────────────────────────────────────
//  Per-Activity FTP Indicators (Layer 1)
// ────────────────────────────────────────────────────────────────────────────

/** Trust level for each individual FTP indicator method */
export type IndicatorTrust = "high" | "medium" | "low";

/**
 * One method of estimating FTP from a single activity.
 *
 * The UI should show *all* applicable indicators side by side,
 * letting the user compare them. No single number is labelled
 * "your FTP is X" — instead each says "suggests ~X".
 */
export interface ActivityFtpIndicator {
  /** Machine-readable method key */
  method: "best20min" | "best60min" | "np_based" | "cp_model";

  /** Human-readable short label */
  label: string;

  /** Suggested FTP in watts */
  ftp: number;

  /** FTP per kg (null if weight unknown) */
  ftpPerKg: number | null;

  /** Trust badge */
  trust: IndicatorTrust;

  /** One-line explanation of when/why this is valid */
  rationale: string;

  /** Extra detail (e.g. NP, IF, R², duration) */
  detail: string;
}

/**
 * Complete per-activity FTP analysis result.
 * Returned by FtpEstimator.estimateFromActivity().
 */
export interface ActivityFtpAnalysis {
  /** All applicable FTP indicators for this ride */
  indicators: ActivityFtpIndicator[];

  /** Best single indicator (highest trust, then highest FTP) */
  bestIndicator: ActivityFtpIndicator | null;

  /** The ride's key peak powers at standard durations */
  keyPeaks: ActivityKeyPeak[];

  /** All power peaks sorted by duration */
  allPeaks: Array<{ durationSeconds: number; power: number }>;

  /** CP model params if the CP indicator was computed, else null */
  cpModelParams: CriticalPowerModelParams | null;

  /** Detected ride intensity classification */
  rideIntensity: "endurance" | "tempo" | "threshold";

  /** W'bal (W-prime balance) analysis for this activity, null if unavailable */
  wBal: WBalAnalysis | null;
}

/**
 * W'bal (W-prime Balance) analysis for a single activity.
 *
 * Tracks the depletion and recovery of the anaerobic work capacity (W')
 * during a ride, using the Skiba differential model:
 *
 *   When P > CP: W'bal depletes by (P - CP) × Δt joules
 *   When P ≤ CP: W'bal recovers toward W' with time constant τ
 *     τ = 546 × e^(-0.01 × (CP - P)) + 316
 *
 * Reference: Skiba et al., "Modelling the expenditure and reconstitution
 * of work capacity above critical power" (2012).
 */
export interface WBalAnalysis {
  /** W' (total anaerobic work capacity) in joules, from the CP model */
  wPrime: number;

  /** CP (Critical Power) in watts used for this computation */
  cp: number;

  /** Minimum W'bal reached during the activity (joules) */
  minWBal: number;

  /** Minimum W'bal as a percentage of W' (0-100) */
  minWBalPercent: number;

  /** Time (seconds from start) when minimum W'bal occurred */
  minWBalTime: number;

  /** Total W' expended during the activity (joules above CP) */
  totalWPrimeExpended: number;

  /** Number of times W'bal dropped below 50% of W' */
  matchesBurned: number;

  /** W'bal at the end of the activity (joules) */
  endWBal: number;

  /**
   * W'bal trajectory sampled at regular intervals for visualization.
   * Each entry: { time (secs), wBal (joules), wBalPercent (0-100) }
   */
  trajectory: WBalTrajectoryPoint[];
}

/**
 * A single point on the W'bal trajectory during an activity.
 */
export interface WBalTrajectoryPoint {
  /** Time in seconds from activity start */
  time: number;

  /** W'bal in joules at this point */
  wBal: number;

  /** W'bal as percentage of W' (0-100) */
  wBalPercent: number;
}

/** A highlighted peak at a standard duration */
export interface ActivityKeyPeak {
  label: string;
  durationSeconds: number;
  power: number | null;
  wkg: number | null;
}

// ────────────────────────────────────────────────────────────────────────────
//  Cross-Ride FTP Estimate (Layer 2)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A single FTP estimate derived from the aggregated power-duration model
 * across multiple rides in a rolling window.
 */
export interface FtpEstimate {
  /** Estimated FTP in watts */
  ftp: number;

  /** Estimated FTP in watts per kg (null if weight unavailable) */
  ftpPerKg: number | null;

  /** Date when this estimate was computed (ISO string) */
  estimatedOn: string;

  /** Confidence assessment */
  confidence: FtpConfidence;

  /** Critical Power model parameters used */
  modelParams: CriticalPowerModelParams;

  /** IDs of activities that contributed to this estimate */
  contributingActivityIds: (string | number)[];

  /** Date range of contributing activities */
  dataWindowStart: string;
  dataWindowEnd: string;

  /** Number of qualifying efforts used */
  effortCount: number;
}

/**
 * Historical FTP estimate for trend tracking.
 */
export interface FtpTrendPoint {
  /** Date of the estimate (ISO string, typically the date of the latest contributing ride) */
  date: string;

  /** Estimated FTP in watts */
  ftp: number;

  /** FTP per kg */
  ftpPerKg: number | null;

  /** Confidence score 0-100 */
  confidence: number;

  /** Confidence label */
  confidenceLabel: "high" | "moderate" | "low" | "insufficient";

  /** Manual override value if user set one (null if automatic) */
  manualOverride: number | null;

  /** Number of activities in the estimation window */
  activityCount: number;
}

/**
 * Left/right power balance analysis for a single activity.
 */
export interface PowerBalanceAnalysis {
  /** Overall average left percentage (e.g., 51.2) */
  avgLeftPercent: number;

  /** Overall average right percentage (e.g., 48.8) */
  avgRightPercent: number;

  /** Standard deviation of left balance per minute */
  balanceStdDev: number;

  /** Balance consistency score 0-1 (lower std dev = higher score) */
  consistencyScore: number;

  /** Whether there is a significant asymmetry (> 55/45) */
  hasSignificantAsymmetry: boolean;

  /** Dominant side */
  dominantSide: "left" | "right" | "balanced";

  /** Per-interval balance data for trend visualization */
  intervalData: PowerBalanceInterval[];

  /** Contextual notes about the balance */
  notes: string[];
}

/**
 * Power balance for a time interval within a ride.
 */
export interface PowerBalanceInterval {
  /** Start time in seconds from activity start */
  startTime: number;

  /** End time in seconds */
  endTime: number;

  /** Left balance percentage for this interval */
  leftPercent: number;

  /** Right balance percentage */
  rightPercent: number;

  /** Average power for this interval */
  avgPower: number;
}

// ────────────────────────────────────────────────────────────────────────────
//  Running Threshold Trend (pace + optional Stryd power)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Historical running threshold estimate for trend tracking.
 *
 * Uses Grade-Adjusted Pace (GAP) as input so terrain is already corrected.
 * HR effort ratio extrapolates any run intensity back to threshold pace.
 * When a running power meter (Stryd) is present, threshold power is also
 * estimated using the same NP×VI pipeline as cycling.
 */
export interface RunningThresholdTrendPoint {
  /** Date of the estimate (ISO date string) */
  date: string;

  /**
   * Estimated threshold pace in seconds per km — terrain-corrected via GAP.
   * Lower value = faster pace = better fitness.
   */
  thresholdPaceSec: number;

  /** Estimated threshold power in watts. Null when no running power meter. */
  thresholdPower: number | null;

  /** Confidence score 0–100 */
  confidence: number;

  /** Confidence label */
  confidenceLabel: "high" | "moderate" | "low" | "insufficient";

  /** Number of qualifying runs in the lookback window */
  activityCount: number;
}
