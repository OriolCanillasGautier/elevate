import { Component, Input, OnInit } from "@angular/core";
import _ from "lodash";
import { Activity } from "@elevate/shared/models/sync/activity.model";
import { FtpEstimator } from "@elevate/shared/sync/compute/ftp-estimator";
import {
  ActivityFtpAnalysis,
  ActivityFtpIndicator,
  ActivityKeyPeak,
  IndicatorTrust
} from "@elevate/shared/models/ftp-estimate.model";

/**
 * Shows per-activity FTP indicators derived from the ride's power data.
 *
 * Instead of one unreliable number, multiple methods are shown side by side —
 * each with a trust badge and rationale — so the athlete can interpret
 * what the ride suggests about their FTP.
 */
@Component({
  selector: "app-activity-view-ftp-estimate",
  template: `
    <div class="ftp-estimate-container" *ngIf="hasPowerData; else noPowerData">
      <!-- Primary FTP estimate (NP-adjusted) -->
      <div class="primary-estimate" *ngIf="npIndicator">
        <div class="primary-value-row" fxLayout="row" fxLayoutAlign="start center" fxLayoutGap="16px">
          <div>
            <span class="primary-ftp-number">{{ npIndicator.ftp }}</span>
            <span class="primary-ftp-unit">W</span>
            <span class="primary-ftp-wkg" *ngIf="npIndicator.ftpPerKg !== null">
              ({{ npIndicator.ftpPerKg }} W/kg)
            </span>
          </div>
          <span class="ride-type-chip" [class]="'chip-' + analysis.rideIntensity">
            {{ analysis.rideIntensity | titlecase }} ride
          </span>
        </div>
        <p class="primary-detail mat-caption">{{ npIndicator.detail }}</p>
        <p class="primary-rationale mat-caption">{{ npIndicator.rationale }}</p>
      </div>

      <div class="no-estimate" *ngIf="!npIndicator">
        <mat-icon fontSet="material-icons-outlined" inline="true">info</mat-icon>
        <span class="mat-caption">
          This ride is too short for FTP estimation. Rides of 45+ minutes with a power meter produce estimates.
        </span>
      </div>

      <!-- Key Peak Powers -->
      <div class="key-peaks-section" *ngIf="analysis?.keyPeaks?.length > 0">
        <div class="section-header mat-caption">Peak powers</div>
        <div class="key-peaks" fxLayout="row wrap" fxLayoutGap="16px" fxLayoutAlign="start center">
          <div class="peak-card" *ngFor="let peak of analysis.keyPeaks" [class.missing]="peak.power === null">
            <div class="peak-duration mat-caption">{{ peak.label }}</div>
            <div class="peak-power mat-h2" *ngIf="peak.power !== null">
              {{ peak.power }}<span class="peak-unit">W</span>
            </div>
            <div class="peak-wkg mat-caption" *ngIf="peak.wkg !== null">
              {{ peak.wkg }} W/kg
            </div>
            <div class="peak-unavailable mat-caption" *ngIf="peak.power === null">
              —
            </div>
          </div>
        </div>
      </div>

      <!-- Power-duration mini table -->
      <div class="pd-table" *ngIf="analysis?.allPeaks?.length > 0">
        <div class="pd-table-header mat-caption">All power peaks recorded this ride</div>
        <div class="pd-row mat-body-2" *ngFor="let peak of analysis.allPeaks">
          <span class="pd-duration">{{ formatDuration(peak.durationSeconds) }}</span>
          <div class="pd-bar-wrapper">
            <div class="pd-bar" [style.width.%]="peakBarWidth(peak.power)"></div>
          </div>
          <span class="pd-power">{{ peak.power }}W</span>
          <span class="pd-wkg mat-caption" *ngIf="athleteWeight > 0">&nbsp;/ {{ roundWkg(peak.power) }} W/kg</span>
        </div>
      </div>
    </div>

    <ng-template #noPowerData>
      <div class="no-power-data mat-caption">
        <mat-icon fontSet="material-icons-outlined" inline="true">info</mat-icon>
        No power meter data available for this activity. FTP estimation requires rides with a power meter.
      </div>
    </ng-template>
  `,
  styles: [`
    .ftp-estimate-container {
      padding: 16px 0;
    }

    .primary-estimate {
      margin-bottom: 24px;
    }

    .primary-ftp-number {
      font-size: 36px;
      font-weight: 500;
    }

    .primary-ftp-unit {
      font-size: 18px;
      opacity: 0.7;
      margin-left: 2px;
    }

    .primary-ftp-wkg {
      font-size: 15px;
      opacity: 0.6;
      margin-left: 8px;
    }

    .ride-type-chip {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 3px 10px;
      border-radius: 12px;
    }

    .chip-endurance {
      background: rgba(33, 150, 243, 0.12);
      color: #2196f3;
    }

    .chip-tempo {
      background: rgba(255, 152, 0, 0.12);
      color: #ff9800;
    }

    .chip-threshold {
      background: rgba(76, 175, 80, 0.12);
      color: #4caf50;
    }

    .primary-detail {
      opacity: 0.7;
      margin: 8px 0 4px;
      font-size: 12px;
    }

    .primary-rationale {
      opacity: 0.55;
      font-size: 12px;
      line-height: 1.4;
      max-width: 600px;
    }

    .no-estimate {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 20px;
      opacity: 0.6;
    }

    .key-peaks-section {
      margin: 20px 0;
    }

    .section-header {
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
    }

    .key-peaks {
      margin-bottom: 4px;
    }

    .peak-card {
      text-align: center;
      padding: 12px 16px;
      border-radius: 8px;
      background: rgba(128, 128, 128, 0.08);
      min-width: 90px;
    }

    .peak-card.missing {
      opacity: 0.4;
    }

    .peak-duration {
      opacity: 0.6;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.5px;
    }

    .peak-power {
      margin: 4px 0 2px;
    }

    .peak-unit {
      font-size: 14px;
      font-weight: 400;
      opacity: 0.7;
    }

    .peak-wkg {
      opacity: 0.6;
    }

    .pd-table {
      margin-top: 20px;
    }

    .pd-table-header {
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .pd-row {
      display: flex;
      align-items: center;
      margin: 4px 0;
      gap: 8px;
    }

    .pd-duration {
      min-width: 64px;
      font-size: 12px;
      opacity: 0.7;
      text-align: right;
    }

    .pd-bar-wrapper {
      flex: 1;
      height: 8px;
      background: rgba(128, 128, 128, 0.1);
      border-radius: 4px;
      overflow: hidden;
    }

    .pd-bar {
      height: 100%;
      background: linear-gradient(to right, #42a5f5, #1976d2);
      border-radius: 4px;
    }

    .pd-power {
      min-width: 54px;
      font-size: 13px;
      font-weight: 500;
      text-align: right;
    }

    .pd-wkg {
      min-width: 64px;
      opacity: 0.6;
    }

    .no-power-data {
      padding: 24px;
      text-align: center;
      opacity: 0.6;
    }
  `]
})
export class ActivityViewFtpEstimateComponent implements OnInit {
  @Input()
  public activity: Activity;

  public hasPowerData: boolean;
  public hasAnyPeak: boolean;
  public analysis: ActivityFtpAnalysis | null;
  public npIndicator: ActivityFtpIndicator | null;
  public athleteWeight: number;

  private maxPower: number;

  public ngOnInit(): void {
    this.hasPowerData = this.activity?.hasPowerMeter && (this.activity?.stats?.power?.avg > 0);
    this.athleteWeight = this.activity?.athleteSnapshot?.athleteSettings?.weight || 0;
    this.analysis = null;
    this.npIndicator = null;
    this.hasAnyPeak = (this.activity?.stats?.power?.peaks?.length || 0) > 0;
    this.maxPower = 0;

    if (this.hasPowerData) {
      this.analysis = FtpEstimator.estimateFromActivity(this.activity, this.athleteWeight);

      if (this.analysis) {
        this.npIndicator = this.analysis.indicators.find(i => i.method === "np_based") || null;

        if (this.analysis.allPeaks?.length > 0) {
          this.maxPower = Math.max(...this.analysis.allPeaks.map(p => p.power));
        }
      }
    }
  }

  public formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (s === 0) return `${m}min`;
    return `${m}m${s}s`;
  }

  public peakBarWidth(power: number): number {
    if (this.maxPower <= 0) return 0;
    return _.round((power / this.maxPower) * 100, 1);
  }

  public roundWkg(power: number): string {
    return this.athleteWeight > 0 ? _.round(power / this.athleteWeight, 2).toFixed(2) : "—";
  }
}
