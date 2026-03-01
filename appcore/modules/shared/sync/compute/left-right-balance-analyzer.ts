import _ from "lodash";
import { PowerBalanceAnalysis, PowerBalanceInterval } from "../../models/ftp-estimate.model";
import { LeftRightPercent, CyclingDynamicsStats } from "../../models/sync/activity.model";
import { Streams } from "../../models/activity-data/streams.model";

/**
 * Left/Right Power Balance Analyzer.
 *
 * Analyzes power distribution between left and right legs for rides
 * recorded with dual-sided power meters. Provides overall balance,
 * per-interval trend data, consistency metrics, and contextual notes.
 *
 * Gracefully falls back for single-sided or non-power rides.
 */
export class LeftRightBalanceAnalyzer {
  /** Interval duration (seconds) for per-interval balance breakdown */
  private static readonly INTERVAL_DURATION = 60;

  /** Threshold for "significant" asymmetry (left percent > this OR < 100 - this) */
  private static readonly SIGNIFICANT_ASYMMETRY_THRESHOLD = 55;

  /** Minimum power threshold to include in balance calculation (avoid noise at low power) */
  private static readonly MIN_POWER_FOR_BALANCE = 50;

  /**
   * Analyze power balance from pre-computed cycling dynamics stats.
   * This is the simpler path when only summary data is available (average L/R balance).
   *
   * @param dynamics Cycling dynamics stats from the activity
   * @returns Analysis result or null if balance data is unavailable
   */
  public static analyzeFromDynamics(dynamics: CyclingDynamicsStats | null): PowerBalanceAnalysis | null {
    if (!dynamics?.balance?.left || !dynamics?.balance?.right) {
      return null;
    }

    const left = dynamics.balance.left;
    const right = dynamics.balance.right;

    if (!Number.isFinite(left) || !Number.isFinite(right) || left + right < 90) {
      return null;
    }

    const hasAsymmetry =
      left >= LeftRightBalanceAnalyzer.SIGNIFICANT_ASYMMETRY_THRESHOLD ||
      right >= LeftRightBalanceAnalyzer.SIGNIFICANT_ASYMMETRY_THRESHOLD;

    let dominantSide: "left" | "right" | "balanced";
    if (Math.abs(left - right) < 2) {
      dominantSide = "balanced";
    } else if (left > right) {
      dominantSide = "left";
    } else {
      dominantSide = "right";
    }

    const notes = LeftRightBalanceAnalyzer.generateNotes(left, right, hasAsymmetry, dominantSide, null);

    return {
      avgLeftPercent: _.round(left, 1),
      avgRightPercent: _.round(right, 1),
      balanceStdDev: 0,
      consistencyScore: 1, // Can't compute without interval data
      hasSignificantAsymmetry: hasAsymmetry,
      dominantSide,
      intervalData: [],
      notes
    };
  }

  /**
   * Analyze power balance from raw streams with left/right power data.
   *
   * This requires that the power meter records separate left/right channels.
   * Since most .FIT files from dual-sided meters include a balance field in
   * the records, this method works with an explicit left balance stream.
   *
   * @param timeArray Time stream (seconds)
   * @param powerArray Total power stream (watts)
   * @param leftBalanceArray Left balance percentage stream (e.g., 51.2 means 51.2% left)
   * @returns Analysis result or null if insufficient data
   */
  public static analyzeFromStreams(
    timeArray: number[],
    powerArray: number[],
    leftBalanceArray: number[]
  ): PowerBalanceAnalysis | null {
    if (
      _.isEmpty(timeArray) ||
      _.isEmpty(powerArray) ||
      _.isEmpty(leftBalanceArray) ||
      timeArray.length !== powerArray.length ||
      timeArray.length !== leftBalanceArray.length
    ) {
      return null;
    }

    // Filter out low-power samples (balance meaningless at very low power)
    const validIndices: number[] = [];
    for (let i = 0; i < powerArray.length; i++) {
      if (
        powerArray[i] >= LeftRightBalanceAnalyzer.MIN_POWER_FOR_BALANCE &&
        leftBalanceArray[i] > 0 &&
        leftBalanceArray[i] < 100
      ) {
        validIndices.push(i);
      }
    }

    if (validIndices.length < 10) {
      return null;
    }

    // Compute overall weighted average (weighted by power)
    let totalPowerWeightedLeft = 0;
    let totalPower = 0;
    for (const idx of validIndices) {
      totalPowerWeightedLeft += leftBalanceArray[idx] * powerArray[idx];
      totalPower += powerArray[idx];
    }
    const avgLeftPercent = totalPower > 0 ? totalPowerWeightedLeft / totalPower : 50;
    const avgRightPercent = 100 - avgLeftPercent;

    // Compute per-interval balance
    const intervalData = LeftRightBalanceAnalyzer.computeIntervalBalance(
      timeArray,
      powerArray,
      leftBalanceArray,
      validIndices
    );

    // Compute balance std dev across intervals
    const intervalLeftValues = intervalData.map(d => d.leftPercent);
    const balanceStdDev =
      intervalLeftValues.length > 1
        ? Math.sqrt(_.mean(intervalLeftValues.map(v => Math.pow(v - avgLeftPercent, 2))))
        : 0;

    // Consistency score: lower std dev = more consistent = higher score
    // A std dev of 0 = perfect consistency (1.0), std dev of 10+ = poor (0.1)
    const consistencyScore = Math.max(0.1, Math.min(1.0, 1 - balanceStdDev / 12));

    const hasAsymmetry =
      avgLeftPercent >= LeftRightBalanceAnalyzer.SIGNIFICANT_ASYMMETRY_THRESHOLD ||
      avgRightPercent >= LeftRightBalanceAnalyzer.SIGNIFICANT_ASYMMETRY_THRESHOLD;

    let dominantSide: "left" | "right" | "balanced";
    if (Math.abs(avgLeftPercent - avgRightPercent) < 2) {
      dominantSide = "balanced";
    } else if (avgLeftPercent > avgRightPercent) {
      dominantSide = "left";
    } else {
      dominantSide = "right";
    }

    const notes = LeftRightBalanceAnalyzer.generateNotes(
      avgLeftPercent,
      avgRightPercent,
      hasAsymmetry,
      dominantSide,
      balanceStdDev
    );

    return {
      avgLeftPercent: _.round(avgLeftPercent, 1),
      avgRightPercent: _.round(avgRightPercent, 1),
      balanceStdDev: _.round(balanceStdDev, 2),
      consistencyScore: _.round(consistencyScore, 3),
      hasSignificantAsymmetry: hasAsymmetry,
      dominantSide,
      intervalData,
      notes
    };
  }

  /**
   * Compute per-interval (e.g., per-minute) left/right balance.
   */
  private static computeIntervalBalance(
    timeArray: number[],
    powerArray: number[],
    leftBalanceArray: number[],
    validIndices: number[]
  ): PowerBalanceInterval[] {
    const intervals: PowerBalanceInterval[] = [];
    const activityDuration = _.last(timeArray) - timeArray[0];
    const intervalDuration = LeftRightBalanceAnalyzer.INTERVAL_DURATION;

    for (let startTime = timeArray[0]; startTime < timeArray[0] + activityDuration; startTime += intervalDuration) {
      const endTime = startTime + intervalDuration;

      // Find valid samples in this interval
      const intervalIndices = validIndices.filter(idx => timeArray[idx] >= startTime && timeArray[idx] < endTime);

      if (intervalIndices.length < 3) {
        continue;
      }

      // Power-weighted balance for this interval
      let weightedLeft = 0;
      let totalPower = 0;
      for (const idx of intervalIndices) {
        weightedLeft += leftBalanceArray[idx] * powerArray[idx];
        totalPower += powerArray[idx];
      }

      if (totalPower > 0) {
        const leftPercent = weightedLeft / totalPower;
        intervals.push({
          startTime: startTime - timeArray[0],
          endTime: endTime - timeArray[0],
          leftPercent: _.round(leftPercent, 1),
          rightPercent: _.round(100 - leftPercent, 1),
          avgPower: _.round(totalPower / intervalIndices.length, 0)
        });
      }
    }

    return intervals;
  }

  /**
   * Generate contextual notes about the power balance.
   */
  private static generateNotes(
    leftPercent: number,
    rightPercent: number,
    hasSignificantAsymmetry: boolean,
    dominantSide: "left" | "right" | "balanced",
    stdDev: number | null
  ): string[] {
    const notes: string[] = [];
    const diff = Math.abs(leftPercent - rightPercent);

    if (dominantSide === "balanced") {
      notes.push(
        `Excellent balance: ${_.round(leftPercent, 1)}% / ${_.round(rightPercent, 1)}% (L/R). ` +
          "Power distribution is nearly even between both legs."
      );
    } else if (hasSignificantAsymmetry) {
      notes.push(
        `Significant asymmetry detected: ${_.round(leftPercent, 1)}% / ${_.round(rightPercent, 1)}% (L/R). ` +
          `The ${dominantSide} leg is producing ${_.round(diff, 1)}% more power. ` +
          "Consider consulting a bike fitter or physiotherapist if this persists."
      );
    } else if (diff >= 3) {
      notes.push(
        `Mild imbalance: ${_.round(leftPercent, 1)}% / ${_.round(rightPercent, 1)}% (L/R). ` +
          `The ${dominantSide} leg is slightly dominant. This is common and generally not a concern.`
      );
    } else {
      notes.push(
        `Good balance: ${_.round(leftPercent, 1)}% / ${_.round(rightPercent, 1)}% (L/R). ` +
          "Power distribution is well balanced."
      );
    }

    if (stdDev !== null && stdDev > 0) {
      if (stdDev > 5) {
        notes.push(
          `Balance varies significantly throughout the ride (σ = ${_.round(stdDev, 1)}%). ` +
            "This may indicate fatigue-related compensation or terrain-dependent technique changes."
        );
      } else if (stdDev > 3) {
        notes.push(
          `Balance shows moderate variation (σ = ${_.round(stdDev, 1)}%). ` +
            "Some variation is normal, especially during mixed-terrain rides."
        );
      } else {
        notes.push(
          `Balance is very consistent throughout the ride (σ = ${_.round(stdDev, 1)}%). ` +
            "This indicates a stable pedaling technique."
        );
      }
    }

    return notes;
  }
}
