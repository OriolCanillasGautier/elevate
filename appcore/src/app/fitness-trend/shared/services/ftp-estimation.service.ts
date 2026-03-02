import { Inject, Injectable } from "@angular/core";
import { ActivityService } from "../../../shared/services/activity/activity.service";
import { FtpEstimator } from "@elevate/shared/sync/compute/ftp-estimator";
import { FtpEstimate, FtpTrendPoint, RunningThresholdTrendPoint } from "@elevate/shared/models/ftp-estimate.model";
import { Activity } from "@elevate/shared/models/sync/activity.model";
import { DayFitnessTrendModel } from "../models/day-fitness-trend.model";
import { LoggerService } from "../../../shared/services/logging/logger.service";

/**
 * Angular service that wraps the FTP estimation engine.
 *
 * Fetches activities from the activity service, runs the estimation pipeline,
 * and provides FTP estimates and trend data to UI components.
 */
@Injectable()
export class FtpEstimationService {
  constructor(
    @Inject(ActivityService) private readonly activityService: ActivityService,
    @Inject(LoggerService) private readonly logger: LoggerService
  ) { }

  /**
   * Compute the current FTP estimate from all synced cycling activities.
   *
   * @param athleteWeight Athlete weight in kg
   * @param windowDays Estimation window (default: 90 days)
   * @returns FTP estimate or null if insufficient data
   */
  public async estimateCurrentFtp(
    athleteWeight: number,
    windowDays: number = FtpEstimator.DEFAULT_WINDOW_DAYS
  ): Promise<FtpEstimate | null> {
    try {
      const activities = await this.activityService.fetch();
      return FtpEstimator.estimateFromPeaks(activities, athleteWeight, windowDays);
    } catch (err) {
      this.logger.error("Error estimating FTP:", err);
      return null;
    }
  }

  /**
   * Compute the FTP trend over time.
   *
   * @param athleteWeight Athlete weight in kg
   * @param windowDays Estimation window per data point (default: 90 days)
   * @param intervalDays Interval between trend points (default: 7 days = weekly)
   * @param manualFtps Optional map of date → manual FTP override values
   * @param excludeTrainer Whether to exclude trainer/indoor rides
   * @param fitnessTrend Fitness trend data for CTL-based decay
   * @returns Array of FTP trend points
   */
  public async computeFtpTrend(
    athleteWeight: number,
    windowDays: number = FtpEstimator.DEFAULT_WINDOW_DAYS,
    intervalDays: number = 7,
    manualFtps?: Map<string, number>,
    excludeTrainer: boolean = false,
    fitnessTrend?: DayFitnessTrendModel[]
  ): Promise<FtpTrendPoint[]> {
    try {
      const activities = await this.activityService.fetch();

      // Build CTL lookup from fitness trend data
      let ctlByDate: Map<string, number> | undefined;
      if (fitnessTrend?.length > 0) {
        ctlByDate = new Map();
        for (const day of fitnessTrend) {
          if (day.dateString && day.ctl != null) {
            ctlByDate.set(day.dateString, day.ctl);
          }
        }
      }

      return FtpEstimator.computeTrend(
        activities,
        athleteWeight,
        windowDays,
        intervalDays,
        manualFtps,
        excludeTrainer,
        ctlByDate
      );
    } catch (err) {
      this.logger.error("Error computing FTP trend:", err);
      return [];
    }
  }

  /**
   * Get the latest FTP estimate (quick sync version using just peaks).
   */
  public async getLatestEstimate(athleteWeight: number): Promise<FtpEstimate | null> {
    return this.estimateCurrentFtp(athleteWeight);
  }

  /**
   * Compute the running threshold pace (and optionally power) trend over time.
   *
   * @param athleteWeight Athlete weight in kg
   * @param windowDays Lookback window for confidence scoring (default: 90 days)
   * @param intervalDays Interval between trend points (default: 7 days)
   * @param fitnessTrend Optional fitness trend data for CTL-based decay modulation
   * @returns Array of running threshold trend points
   */
  public async computeRunningThresholdTrend(
    athleteWeight: number,
    windowDays: number = 90,
    intervalDays: number = 7,
    fitnessTrend?: DayFitnessTrendModel[]
  ): Promise<RunningThresholdTrendPoint[]> {
    try {
      const activities = await this.activityService.fetch();

      let ctlByDate: Map<string, number> | undefined;
      if (fitnessTrend?.length > 0) {
        ctlByDate = new Map();
        for (const day of fitnessTrend) {
          if (day.dateString && day.ctl != null) {
            ctlByDate.set(day.dateString, day.ctl);
          }
        }
      }

      return FtpEstimator.computeRunningThresholdTrend(activities, athleteWeight, windowDays, intervalDays, ctlByDate);
    } catch (err) {
      this.logger.error("Error computing running threshold trend:", err);
      return [];
    }
  }
}
