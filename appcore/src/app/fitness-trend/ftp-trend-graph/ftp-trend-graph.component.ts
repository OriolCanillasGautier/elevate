import { Component, Inject, Input, OnChanges, OnInit, SimpleChanges } from "@angular/core";
import _ from "lodash";
import { AppService } from "../../shared/services/app-service/app.service";
import { Theme } from "../../shared/enums/theme.enum";
import { FtpTrendPoint } from "@elevate/shared/models/ftp-estimate.model";

/**
 * FTP Trend Graph Component.
 *
 * Displays historical FTP estimates as an interactive line graph with
 * confidence interval shading. Integrates into the Fitness Trend screen.
 */
@Component({
  selector: "app-ftp-trend-graph",
  template: `
    <div class="ftp-trend-container" *ngIf="trendPoints?.length > 0">
      <p class="mat-caption ftp-description">
        Your FTP is estimated from each qualifying ride using the NP-adjusted method and smoothed over time. Harder
        rides (threshold) contribute more weight than easy rides (endurance). The confidence band reflects how many
        rides contributed in each period.
      </p>

      <div class="ftp-summary" *ngIf="currentEstimate">
        <div class="ftp-value" fxLayout="row" fxLayoutAlign="start center" fxLayoutGap="16px">
          <div>
            <span class="ftp-number">{{ currentEstimate.ftp }}</span>
            <span class="ftp-unit">W</span>
            <span class="ftp-wkg" *ngIf="currentEstimate.ftpPerKg"> ({{ currentEstimate.ftpPerKg }} W/kg) </span>
          </div>
          <mat-chip-list>
            <mat-chip [color]="confidenceChipColor" selected>
              {{ currentEstimate.confidenceLabel | titlecase }} confidence
            </mat-chip>
          </mat-chip-list>
          <span class="ftp-manual" *ngIf="currentEstimate.manualOverride">
            <mat-icon fontSet="material-icons-outlined" inline="true">edit</mat-icon>
            Manual: {{ currentEstimate.manualOverride }}W
          </span>
        </div>
      </div>

      <plotly-plot
        *ngIf="chartData?.length > 0"
        [data]="chartData"
        [layout]="chartLayout"
        [config]="chartConfig"
        [useResizeHandler]="true"
        [style]="{ width: '100%', height: '300px' }"
      ></plotly-plot>

      <div class="ftp-details-panel" *ngIf="selectedPoint">
        <mat-card class="selected-point-card">
          <mat-card-content>
            <div fxLayout="row" fxLayoutAlign="space-between center">
              <div>
                <strong>{{ selectedPoint.date }}</strong>
                — Estimated FTP: <strong>{{ selectedPoint.ftp }}W</strong>
                <span *ngIf="selectedPoint.ftpPerKg">({{ selectedPoint.ftpPerKg }} W/kg)</span>
              </div>
              <div>
                <span class="mat-caption">
                  {{ selectedPoint.activityCount }} rides contributed &bull;
                  {{ selectedPoint.confidenceLabel | titlecase }} confidence ({{ selectedPoint.confidence }}%)
                </span>
              </div>
            </div>
          </mat-card-content>
        </mat-card>
      </div>
    </div>

    <div class="ftp-trend-empty" *ngIf="!trendPoints || trendPoints.length === 0">
      <mat-card>
        <mat-card-content>
          <div fxLayout="column" fxLayoutAlign="center center" fxLayoutGap="8px">
            <div fxLayout="row" fxLayoutAlign="center center" fxLayoutGap="8px">
              <mat-icon fontSet="material-icons-outlined" color="accent">flash_on</mat-icon>
              <span>
                FTP estimation requires cycling rides recorded with a power meter. Keep riding and your FTP trend will
                appear here once you have 2+ qualifying rides within a 90-day window.
              </span>
            </div>
            <p class="mat-caption" style="max-width: 600px; text-align: center;">
              No dedicated FTP test rides needed — Elevate analyzes your power outputs across regular rides to build a
              power-duration profile and derive your threshold. Rides with diverse efforts (climbs, intervals, sustained
              tempo) provide the best data.
            </p>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [
    `
      .ftp-trend-container {
        padding: 16px 0;
      }

      .ftp-summary {
        margin-bottom: 12px;
      }

      .ftp-description {
        max-width: 700px;
        opacity: 0.7;
        margin-bottom: 16px;
        line-height: 1.5;
      }

      .ftp-number {
        font-size: 32px;
        font-weight: 500;
      }

      .ftp-unit {
        font-size: 16px;
        opacity: 0.7;
        margin-left: 2px;
      }

      .ftp-wkg {
        font-size: 14px;
        opacity: 0.6;
        margin-left: 8px;
      }

      .ftp-manual {
        font-size: 13px;
        opacity: 0.6;
      }

      .selected-point-card {
        margin-top: 8px;
      }

      .ftp-trend-empty mat-card {
        text-align: center;
        opacity: 0.7;
      }
    `
  ]
})
export class FtpTrendGraphComponent implements OnInit, OnChanges {
  @Input()
  public trendPoints: FtpTrendPoint[];

  public chartData: any[];
  public chartLayout: any;
  public chartConfig: any;
  public currentEstimate: FtpTrendPoint | null;
  public selectedPoint: FtpTrendPoint | null;
  public confidenceChipColor: string;

  private isDarkTheme: boolean;

  constructor(@Inject(AppService) private readonly appService: AppService) {
    this.chartData = [];
    this.chartLayout = {};
    this.chartConfig = { displayModeBar: false, showTips: false, displaylogo: false };
    this.currentEstimate = null;
    this.selectedPoint = null;
    this.isDarkTheme = false;
    this.confidenceChipColor = "primary";
  }

  public ngOnInit(): void {
    this.isDarkTheme = this.appService.currentTheme === Theme.DARK;
    this.appService.themeChanges$.subscribe(theme => {
      this.isDarkTheme = theme === Theme.DARK;
      this.buildChart();
    });

    this.buildChart();
  }

  public ngOnChanges(changes: SimpleChanges): void {
    if (changes.trendPoints) {
      this.buildChart();
    }
  }

  private buildChart(): void {
    if (!this.trendPoints || this.trendPoints.length === 0) {
      this.chartData = [];
      this.currentEstimate = null;
      return;
    }

    // Most recent estimate
    this.currentEstimate = this.trendPoints[this.trendPoints.length - 1];
    this.confidenceChipColor = this.getConfidenceColor(this.currentEstimate.confidenceLabel);

    const dates = this.trendPoints.map(p => p.date);
    const ftpValues = this.trendPoints.map(p => p.ftp);
    const confidences = this.trendPoints.map(p => p.confidence);

    // Confidence-based upper/lower band (± proportional to inverse confidence)
    const upperBand = this.trendPoints.map(p => p.ftp + (100 - p.confidence) * 0.3);
    const lowerBand = this.trendPoints.map(p => Math.max(0, p.ftp - (100 - p.confidence) * 0.3));

    const textColor = this.isDarkTheme ? "white" : "black";
    const gridColor = this.isDarkTheme ? "#4d4d4d" : "#efefef";
    const lineColor = "#1976d2";
    const bandColor = this.isDarkTheme ? "rgba(25, 118, 210, 0.15)" : "rgba(25, 118, 210, 0.1)";

    // Confidence band (lower)
    const lowerTrace: any = {
      x: dates,
      y: lowerBand,
      type: "scatter",
      mode: "lines",
      line: { width: 0 },
      showlegend: false,
      hoverinfo: "skip"
    };

    // Confidence band (upper, filled to lower)
    const upperTrace: any = {
      x: dates,
      y: upperBand,
      type: "scatter",
      mode: "lines",
      fill: "tonexty",
      fillcolor: bandColor,
      line: { width: 0 },
      showlegend: false,
      hoverinfo: "skip",
      name: "Confidence Band"
    };

    // FTP line
    const ftpTrace: any = {
      x: dates,
      y: ftpValues,
      type: "scatter",
      mode: "lines+markers",
      name: "Estimated FTP",
      line: { color: lineColor, width: 2, shape: "spline" },
      marker: { size: 6, color: lineColor },
      hovertemplate: "%{y:.0f}W<br>%{x}<extra></extra>"
    };

    // Manual override markers (if any)
    const manualPoints = this.trendPoints.filter(p => p.manualOverride != null);
    const manualTrace: any = {
      x: manualPoints.map(p => p.date),
      y: manualPoints.map(p => p.manualOverride),
      type: "scatter",
      mode: "markers",
      name: "Manual FTP",
      marker: { size: 8, color: "#ff9800", symbol: "diamond" },
      hovertemplate: "Manual: %{y:.0f}W<br>%{x}<extra></extra>"
    };

    this.chartData = [lowerTrace, upperTrace, ftpTrace];
    if (manualPoints.length > 0) {
      this.chartData.push(manualTrace);
    }

    this.chartLayout = {
      font: { size: 11, family: "Roboto", color: textColor },
      title: {},
      hovermode: "closest",
      height: 300,
      margin: { t: 20, b: 50, l: 60, r: 20 },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      xaxis: {
        type: "date",
        gridcolor: gridColor,
        tickfont: { color: textColor }
      },
      yaxis: {
        title: "FTP (watts)",
        gridcolor: gridColor,
        tickfont: { color: textColor },
        zeroline: false
      },
      legend: {
        orientation: "h",
        y: -0.2,
        font: { color: textColor }
      }
    };
  }

  private getConfidenceColor(label: string): string {
    switch (label) {
      case "high":
        return "primary";
      case "moderate":
        return "accent";
      case "low":
      case "insufficient":
        return "warn";
      default:
        return "primary";
    }
  }

  public onPointClicked(point: FtpTrendPoint): void {
    this.selectedPoint = point;
  }
}
