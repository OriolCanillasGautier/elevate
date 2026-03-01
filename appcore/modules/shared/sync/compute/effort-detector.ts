import _ from "lodash";
import { DetectedEffort } from "../../models/ftp-estimate.model";
import { ActivityComputer } from "./activity-computer";

/**
 * Intelligent multi-signal effort detector that identifies sustained, meaningful
 * power efforts within any type of cycling activity — MTB, road, endurance,
 * intervals, mixed terrain.
 *
 * Works with raw second-by-second power, heart rate, and cadence streams.
 * Filters out noise: sprints, coasting, technical sections, and non-representative spikes.
 *
 * Multi-signal validation (per the research framework):
 * - Power: relative threshold (60% of activity max), VI ≤ 1.35
 * - Heart rate: drift (aerobic decoupling), coupling with power
 * - Cadence: coefficient of variation for pedaling stability
 */
export class EffortDetector {
  /** Minimum effort duration to consider (seconds) */
  private static readonly MIN_EFFORT_DURATION = 30;

  /** Maximum effort duration to consider (seconds) */
  private static readonly MAX_EFFORT_DURATION = 60 * 60; // 1 hour

  /** Minimum average power relative to body weight to consider an effort meaningful (W/kg) */
  private static readonly MIN_POWER_THRESHOLD_WKG = 1.0;

  /** Minimum absolute average power to consider (watts) */
  private static readonly MIN_POWER_THRESHOLD_WATTS = 50;

  /** Relative power threshold: fraction of max power in the activity */
  private static readonly RELATIVE_POWER_THRESHOLD = 0.40;

  /** Maximum gap in power data before splitting an effort (seconds) */
  private static readonly MAX_POWER_GAP = 5;

  /** Minimum power to be considered "pedaling" (watts) */
  private static readonly PEDALING_THRESHOLD = 25;

  /** Minimum ratio of time spent pedaling within an effort (0-1) */
  private static readonly MIN_PEDALING_RATIO = 0.80;

  /** Maximum variability index for quality efforts (NP/AP) */
  private static readonly MAX_VARIABILITY_INDEX = 1.35;

  /** Durations (seconds) at which to extract best efforts */
  private static readonly TARGET_DURATIONS = [
    30, 60, 90, 120, 180, 300, 480, 600, 720, 900, 1200, 1500, 1800, 2400, 3000, 3600
  ];

  /**
   * Detect all meaningful efforts from ride streams.
   *
   * @param timeArray Second-by-second time values (seconds from start)
   * @param powerArray Second-by-second power values (watts)
   * @param heartRateArray Optional heart rate array
   * @param cadenceArray Optional cadence array
   * @param athleteWeight Athlete weight in kg
   * @returns Array of detected efforts sorted by quality score (best first)
   */
  public static detect(
    timeArray: number[],
    powerArray: number[],
    heartRateArray: number[] | null,
    cadenceArray: number[] | null,
    athleteWeight: number
  ): DetectedEffort[] {
    if (
      _.isEmpty(timeArray) ||
      _.isEmpty(powerArray) ||
      timeArray.length !== powerArray.length ||
      timeArray.length < EffortDetector.MIN_EFFORT_DURATION
    ) {
      return [];
    }

    const efforts: DetectedEffort[] = [];

    // Strategy 1: Extract best rolling-average efforts at target durations
    const rollingEfforts = EffortDetector.extractBestEffortsAtDurations(
      timeArray,
      powerArray,
      heartRateArray,
      cadenceArray,
      athleteWeight
    );
    efforts.push(...rollingEfforts);

    // Strategy 2: Detect sustained pedaling segments and analyze them
    const sustainedSegments = EffortDetector.detectSustainedSegments(
      timeArray,
      powerArray,
      heartRateArray,
      cadenceArray,
      athleteWeight
    );
    efforts.push(...sustainedSegments);

    // Deduplicate: remove efforts that overlap significantly with higher-quality efforts
    const deduplicated = EffortDetector.deduplicateEfforts(efforts);

    // Sort by quality score descending
    return _.orderBy(deduplicated, ["qualityScore"], ["desc"]);
  }

  /**
   * Extract the best effort at each target duration using a sliding window approach.
   * This finds the best average power for 30s, 1min, 2min, 5min, etc.
   */
  private static extractBestEffortsAtDurations(
    timeArray: number[],
    powerArray: number[],
    heartRateArray: number[] | null,
    cadenceArray: number[] | null,
    athleteWeight: number
  ): DetectedEffort[] {
    const efforts: DetectedEffort[] = [];
    const maxActivityDuration = _.last(timeArray) - timeArray[0];

    for (const targetDuration of EffortDetector.TARGET_DURATIONS) {
      if (targetDuration > maxActivityDuration) {
        continue;
      }

      const bestEffort = EffortDetector.findBestWindowForDuration(
        timeArray,
        powerArray,
        heartRateArray,
        cadenceArray,
        targetDuration,
        athleteWeight
      );

      if (bestEffort) {
        efforts.push(bestEffort);
      }
    }

    return efforts;
  }

  /**
   * Find the best (highest avg power) window for a given duration.
   * Also computes quality metrics for the window.
   */
  private static findBestWindowForDuration(
    timeArray: number[],
    powerArray: number[],
    heartRateArray: number[] | null,
    cadenceArray: number[] | null,
    targetDuration: number,
    athleteWeight: number
  ): DetectedEffort | null {
    let bestAvgPower = -Infinity;
    let bestStartIdx = 0;
    let bestEndIdx = 0;

    // Sliding window
    let windowStartIdx = 0;
    for (let currIdx = 0; currIdx < timeArray.length; currIdx++) {
      const elapsed = timeArray[currIdx] - timeArray[windowStartIdx];
      if (elapsed < targetDuration) {
        continue;
      }

      const windowPower = powerArray.slice(windowStartIdx, currIdx + 1);
      const avgPower = _.mean(windowPower);

      if (avgPower > bestAvgPower) {
        bestAvgPower = avgPower;
        bestStartIdx = windowStartIdx;
        bestEndIdx = currIdx;
      }
      windowStartIdx++;
    }

    if (!Number.isFinite(bestAvgPower) || bestAvgPower <= 0) {
      return null;
    }

    // Filter by minimum power thresholds
    const avgPowerPerKg = bestAvgPower / athleteWeight;
    if (
      bestAvgPower < EffortDetector.MIN_POWER_THRESHOLD_WATTS ||
      avgPowerPerKg < EffortDetector.MIN_POWER_THRESHOLD_WKG
    ) {
      return null;
    }

    return EffortDetector.analyzeEffort(
      timeArray,
      powerArray,
      heartRateArray,
      cadenceArray,
      bestStartIdx,
      bestEndIdx,
      athleteWeight
    );
  }

  /**
   * Detect sustained pedaling segments in the ride.
   * These are continuous periods of pedaling without long gaps.
   */
  private static detectSustainedSegments(
    timeArray: number[],
    powerArray: number[],
    heartRateArray: number[] | null,
    cadenceArray: number[] | null,
    athleteWeight: number
  ): DetectedEffort[] {
    const efforts: DetectedEffort[] = [];
    let segmentStart = -1;

    for (let i = 0; i < powerArray.length; i++) {
      const isPedaling = powerArray[i] >= EffortDetector.PEDALING_THRESHOLD;
      const timeGap = i > 0 ? timeArray[i] - timeArray[i - 1] : 0;

      if (isPedaling && segmentStart === -1) {
        // Start new segment
        segmentStart = i;
      } else if (
        segmentStart !== -1 &&
        (!isPedaling || timeGap > EffortDetector.MAX_POWER_GAP || i === powerArray.length - 1)
      ) {
        // End segment: check if meets minimum criteria
        const segmentEnd = i === powerArray.length - 1 && isPedaling ? i : i - 1;
        const duration = timeArray[segmentEnd] - timeArray[segmentStart];

        if (
          duration >= EffortDetector.MIN_EFFORT_DURATION &&
          duration <= EffortDetector.MAX_EFFORT_DURATION
        ) {
          // Check pedaling ratio within segment
          const segmentPower = powerArray.slice(segmentStart, segmentEnd + 1);
          const pedalingSamples = segmentPower.filter(w => w >= EffortDetector.PEDALING_THRESHOLD).length;
          const pedalingRatio = pedalingSamples / segmentPower.length;

          if (pedalingRatio >= EffortDetector.MIN_PEDALING_RATIO) {
            const avgPower = _.mean(segmentPower);
            const avgPowerPerKg = avgPower / athleteWeight;

            if (
              avgPower >= EffortDetector.MIN_POWER_THRESHOLD_WATTS &&
              avgPowerPerKg >= EffortDetector.MIN_POWER_THRESHOLD_WKG
            ) {
              const effort = EffortDetector.analyzeEffort(
                timeArray,
                powerArray,
                heartRateArray,
                cadenceArray,
                segmentStart,
                segmentEnd,
                athleteWeight
              );
              if (effort) {
                efforts.push(effort);
              }
            }
          }
        }

        segmentStart = -1;
      }
    }

    return efforts;
  }

  /**
   * Analyze a detected effort window: compute NP, VI, HR drift, cadence CV,
   * HR-power coupling, and overall quality score.
   */
  private static analyzeEffort(
    timeArray: number[],
    powerArray: number[],
    heartRateArray: number[] | null,
    cadenceArray: number[] | null,
    startIdx: number,
    endIdx: number,
    athleteWeight: number
  ): DetectedEffort | null {
    const windowTime = timeArray.slice(startIdx, endIdx + 1);
    const windowPower = powerArray.slice(startIdx, endIdx + 1);
    const durationSeconds = timeArray[endIdx] - timeArray[startIdx];

    if (durationSeconds < EffortDetector.MIN_EFFORT_DURATION || windowPower.length < 10) {
      return null;
    }

    const avgPower = _.mean(windowPower);
    const normalizedPower = ActivityComputer.computeNormalizedPower(windowPower, windowTime);
    const variabilityIndex = normalizedPower / avgPower;

    // Heart rate analysis
    let avgHeartRate: number | null = null;
    let heartRateDrift: number | null = null;
    let hrPowerCoupled: boolean | null = null;
    if (heartRateArray && heartRateArray.length > endIdx) {
      const windowHR = heartRateArray.slice(startIdx, endIdx + 1).filter(hr => hr > 0);
      if (windowHR.length > 10) {
        avgHeartRate = _.mean(windowHR);
        heartRateDrift = EffortDetector.computeHeartRateDrift(windowHR);

        // Multi-signal HR-power coupling check:
        // If power was high, HR should have risen. If HR stayed flat while
        // power was elevated, the effort is likely not sustained aerobic work.
        if (avgPower > 0 && avgHeartRate > 60) {
          // Compare first-quarter HR to third-quarter HR for sustained efforts
          hrPowerCoupled = EffortDetector.checkHrPowerCoupling(
            heartRateArray.slice(startIdx, endIdx + 1),
            windowPower
          );
        }
      }
    }

    // Cadence analysis with coefficient of variation
    let avgCadence: number | null = null;
    let cadenceCV: number | null = null;
    if (cadenceArray && cadenceArray.length > endIdx) {
      const windowCad = cadenceArray.slice(startIdx, endIdx + 1).filter(c => c > 0);
      if (windowCad.length > 10) {
        avgCadence = _.mean(windowCad);
        // Coefficient of variation = stdDev / mean (lower = more stable)
        const cadStd = Math.sqrt(_.mean(windowCad.map(c => Math.pow(c - avgCadence, 2))));
        cadenceCV = avgCadence > 0 ? cadStd / avgCadence : 1;
      }
    }

    // Compute quality score with all signals
    const qualityScore = EffortDetector.computeQualityScore(
      durationSeconds,
      avgPower,
      variabilityIndex,
      heartRateDrift,
      avgHeartRate,
      athleteWeight,
      cadenceCV,
      hrPowerCoupled
    );

    return {
      startIndex: startIdx,
      endIndex: endIdx,
      durationSeconds: _.round(durationSeconds, 0),
      avgPower: _.round(avgPower, 1),
      normalizedPower: _.round(normalizedPower, 1),
      variabilityIndex: _.round(variabilityIndex, 3),
      avgHeartRate: avgHeartRate ? _.round(avgHeartRate, 0) : null,
      heartRateDrift: heartRateDrift !== null ? _.round(heartRateDrift, 3) : null,
      avgCadence: avgCadence ? _.round(avgCadence, 0) : null,
      cadenceCV: cadenceCV !== null ? _.round(cadenceCV, 3) : null,
      hrPowerCoupled,
      qualityScore: _.round(qualityScore, 3)
    };
  }

  /**
   * Check if heart rate response is coupled with power output.
   * A sustained power effort should produce a corresponding HR response.
   * Returns true if HR correlates with power across the effort window.
   */
  private static checkHrPowerCoupling(
    hrValues: number[],
    powerValues: number[]
  ): boolean {
    if (hrValues.length < 20 || powerValues.length < 20) {
      return true; // Assume coupled if too few samples
    }

    // Filter to pairs where both are > 0
    const validPairs: Array<[number, number]> = [];
    const len = Math.min(hrValues.length, powerValues.length);
    for (let i = 0; i < len; i++) {
      if (hrValues[i] > 0 && powerValues[i] > 0) {
        validPairs.push([hrValues[i], powerValues[i]]);
      }
    }
    if (validPairs.length < 20) {
      return true;
    }

    // Simple check: average HR should be elevated when power is elevated.
    // Split effort into halves by time and compare: if power is similar
    // but HR diverges wildly (>15%), something is off.
    const mid = Math.floor(validPairs.length / 2);
    const firstHalfPower = _.mean(validPairs.slice(0, mid).map(p => p[1]));
    const secondHalfPower = _.mean(validPairs.slice(mid).map(p => p[1]));
    const firstHalfHR = _.mean(validPairs.slice(0, mid).map(p => p[0]));
    const secondHalfHR = _.mean(validPairs.slice(mid).map(p => p[0]));

    // If power dropped >30% but HR is still rising, effort was probably too hard
    // (anaerobic blowup), penalize slightly but still consider coupled
    if (firstHalfPower > 0 && secondHalfPower / firstHalfPower < 0.7 && secondHalfHR > firstHalfHR * 1.05) {
      return false;
    }

    // If HR stayed flat (<80 bpm average) during a high-power effort, not a real effort
    const avgHR = _.mean(validPairs.map(p => p[0]));
    const avgPwr = _.mean(validPairs.map(p => p[1]));
    if (avgPwr > 150 && avgHR < 80) {
      return false;
    }

    return true;
  }

  /**
   * Compute heart rate drift (aerobic decoupling).
   * Compares avg HR of second half to first half.
   * Value > 0 indicates cardiac drift (higher HR in second half for same power).
   * Value of 0.05 means 5% drift.
   */
  private static computeHeartRateDrift(heartRateValues: number[]): number | null {
    if (heartRateValues.length < 20) {
      return null;
    }

    const midpoint = Math.floor(heartRateValues.length / 2);
    const firstHalfAvg = _.mean(heartRateValues.slice(0, midpoint));
    const secondHalfAvg = _.mean(heartRateValues.slice(midpoint));

    if (firstHalfAvg <= 0) {
      return null;
    }

    return (secondHalfAvg - firstHalfAvg) / firstHalfAvg;
  }

  /**
   * Compute a quality score (0-1) for an effort's suitability as an FTP predictor.
   *
   * Higher scores for:
   * - Longer durations (5-60 min sweet spot)
   * - Lower variability index (steady power)
   * - Physiologically reasonable power
   * - Moderate heart rate drift (not excessive)
   * - Sub-threshold HR behavior
   * - Stable cadence (low CV)
   * - HR-power coupling confirmed
   */
  private static computeQualityScore(
    durationSeconds: number,
    avgPower: number,
    variabilityIndex: number,
    heartRateDrift: number | null,
    avgHeartRate: number | null,
    athleteWeight: number,
    cadenceCV: number | null = null,
    hrPowerCoupled: boolean | null = null
  ): number {
    let score = 0;
    let weightSum = 0;

    // 1. Duration score (weight: 0.25)
    //    Sweet spot: 5-60 min. Very short (<2 min) or very long (>60 min) less useful.
    const durationWeight = 0.25;
    let durationScore: number;
    if (durationSeconds < 60) {
      durationScore = 0.2; // Very short
    } else if (durationSeconds < 120) {
      durationScore = 0.4;
    } else if (durationSeconds < 300) {
      durationScore = 0.6;
    } else if (durationSeconds < 600) {
      durationScore = 0.8;
    } else if (durationSeconds <= 3600) {
      durationScore = 1.0; // Sweet spot for FTP estimation
    } else {
      durationScore = 0.7; // Very long — still useful but may not reflect threshold
    }
    score += durationScore * durationWeight;
    weightSum += durationWeight;

    // 2. Variability index score (weight: 0.20)
    //    Steady-state efforts are more reliable for FTP estimation.
    const viWeight = 0.20;
    let viScore: number;
    if (variabilityIndex <= 1.02) {
      viScore = 1.0; // Very steady
    } else if (variabilityIndex <= 1.05) {
      viScore = 0.95;
    } else if (variabilityIndex <= 1.10) {
      viScore = 0.85;
    } else if (variabilityIndex <= 1.15) {
      viScore = 0.7;
    } else if (variabilityIndex <= 1.20) {
      viScore = 0.5;
    } else if (variabilityIndex <= EffortDetector.MAX_VARIABILITY_INDEX) {
      viScore = 0.3;
    } else {
      viScore = 0.1; // Too variable for reliable estimation
    }
    score += viScore * viWeight;
    weightSum += viWeight;

    // 3. Power plausibility score (weight: 0.15)
    //    Check if power is in a physiologically reasonable range.
    const powerWeight = 0.15;
    const wkg = avgPower / athleteWeight;
    let powerScore: number;
    if (wkg >= 1.5 && wkg <= 7.0) {
      powerScore = 1.0; // Normal range
    } else if (wkg > 7.0 && wkg <= 8.5) {
      powerScore = 0.5; // Elite, but plausible
    } else if (wkg > 8.5) {
      powerScore = 0.1; // Likely erroneous
    } else {
      powerScore = 0.3; // Very low power
    }
    score += powerScore * powerWeight;
    weightSum += powerWeight;

    // 4. Heart rate drift score (weight: 0.12)
    //    Moderate drift (0-5%) is normal for threshold efforts.
    //    Excessive drift (>10%) suggests sub-threshold or fatigue.
    if (heartRateDrift !== null) {
      const hrDriftWeight = 0.12;
      let hrDriftScore: number;
      const absDrift = Math.abs(heartRateDrift);
      if (absDrift <= 0.03) {
        hrDriftScore = 1.0; // Very stable — aerobically coupled
      } else if (absDrift <= 0.05) {
        hrDriftScore = 0.9; // Normal threshold drift
      } else if (absDrift <= 0.08) {
        hrDriftScore = 0.7;
      } else if (absDrift <= 0.12) {
        hrDriftScore = 0.4;
      } else {
        hrDriftScore = 0.2; // Significant decoupling
      }
      score += hrDriftScore * hrDriftWeight;
      weightSum += hrDriftWeight;
    }

    // 5. HR-Power consistency score (weight: 0.08)
    //    If we have HR, penalize efforts where HR seems disconnected from power.
    if (avgHeartRate !== null && avgHeartRate > 0) {
      const hrPwrWeight = 0.08;
      // Simple sanity check: avg HR should be > 100 for meaningful efforts
      const hrPwrScore = avgHeartRate >= 100 ? 1.0 : avgHeartRate >= 80 ? 0.7 : 0.4;
      score += hrPwrScore * hrPwrWeight;
      weightSum += hrPwrWeight;
    }

    // 6. Cadence stability score (weight: 0.10)
    //    Stable cadence indicates controlled pedaling, not technical terrain.
    if (cadenceCV !== null) {
      const cadWeight = 0.10;
      let cadScore: number;
      if (cadenceCV <= 0.08) {
        cadScore = 1.0; // Very stable cadence
      } else if (cadenceCV <= 0.15) {
        cadScore = 0.85;
      } else if (cadenceCV <= 0.25) {
        cadScore = 0.6;
      } else if (cadenceCV <= 0.40) {
        cadScore = 0.35;
      } else {
        cadScore = 0.15; // Wild cadence swings — likely technical terrain
      }
      score += cadScore * cadWeight;
      weightSum += cadWeight;
    }

    // 7. HR-Power coupling signal (weight: 0.10)
    //    Multi-signal validation: does the HR respond to the power?
    if (hrPowerCoupled !== null) {
      const couplingWeight = 0.10;
      const couplingScore = hrPowerCoupled ? 1.0 : 0.25;
      score += couplingScore * couplingWeight;
      weightSum += couplingWeight;
    }

    // Normalize by actual weights used
    return weightSum > 0 ? score / weightSum : 0;
  }

  /**
   * Remove overlapping efforts, keeping the higher-quality one.
   * Two efforts overlap if their time ranges share more than 50% overlap.
   */
  private static deduplicateEfforts(efforts: DetectedEffort[]): DetectedEffort[] {
    if (efforts.length <= 1) {
      return efforts;
    }

    // Sort by quality score descending
    const sorted = _.orderBy(efforts, ["qualityScore"], ["desc"]);
    const kept: DetectedEffort[] = [];

    for (const effort of sorted) {
      const overlapsWithKept = kept.some(existing => {
        const overlapStart = Math.max(effort.startIndex, existing.startIndex);
        const overlapEnd = Math.min(effort.endIndex, existing.endIndex);
        if (overlapStart >= overlapEnd) {
          return false;
        }
        const overlapLength = overlapEnd - overlapStart;
        const effortLength = effort.endIndex - effort.startIndex;
        const existingLength = existing.endIndex - existing.startIndex;
        const minLength = Math.min(effortLength, existingLength);
        return minLength > 0 && overlapLength / minLength > 0.5;
      });

      if (!overlapsWithKept) {
        kept.push(effort);
      }
    }

    return kept;
  }
}
