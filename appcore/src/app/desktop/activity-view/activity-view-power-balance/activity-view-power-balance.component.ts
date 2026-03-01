import { Component, Inject, Input, OnInit } from "@angular/core";
import _ from "lodash";
import { BaseChartComponent } from "../shared/base-chart.component";
import { ScatterChart } from "../shared/models/plot-chart.model";
import { AppService } from "../../../shared/services/app-service/app.service";
import { PlotlyService } from "angular-plotly.js";
import { Layout } from "plotly.js";
import { PowerBalanceAnalysis, PowerBalanceInterval } from "@elevate/shared/models/ftp-estimate.model";
import { Activity, CyclingDynamicsStats } from "@elevate/shared/models/sync/activity.model";
import { LeftRightBalanceAnalyzer } from "@elevate/shared/sync/compute/left-right-balance-analyzer";

/**
 * Left/Right Power Balance component for the activity view.
 *
 * Displays average left/right distribution, per-minute trend chart,
 * consistency metrics, and contextual notes.
 *
 * Falls back gracefully for single-sided or non-power rides.
 */
@Component({
  selector: "app-activity-view-power-balance",
  template: `
    <div class="power-balance-container" *ngIf="analysis">
      <h3 class="mat-subheading-2">
        <mat-icon fontSet="material-icons-outlined" inline="true">balance</mat-icon>
        Left / Right Power Balance
      </h3>

      <p class="mat-caption balance-description">
        Power balance shows how evenly you distribute pedaling force between your left and right legs. A perfectly
        balanced rider produces 50% from each leg. Minor imbalances (up to ~3%) are normal and often vary with
        intensity, fatigue, and terrain. Consistent asymmetries above 55/45 may warrant a bike fit assessment or
        physiotherapy consultation.
      </p>

      <!-- Overall Balance Bar -->
      <div class="balance-overview" fxLayout="row" fxLayoutAlign="center center" fxLayoutGap="16px">
        <div class="balance-side left" fxLayout="column" fxLayoutAlign="center end">
          <span class="balance-label">Left</span>
          <span class="balance-value" [class.dominant]="analysis.dominantSide === 'left'">
            {{ analysis.avgLeftPercent }}%
          </span>
        </div>

        <div class="balance-bar-container" fxFlex="50">
          <div class="balance-bar">
            <div class="balance-left-fill" [style.width.%]="analysis.avgLeftPercent">
              <span *ngIf="analysis.avgLeftPercent > 15">{{ analysis.avgLeftPercent }}%</span>
            </div>
            <div class="balance-right-fill" [style.width.%]="analysis.avgRightPercent">
              <span *ngIf="analysis.avgRightPercent > 15">{{ analysis.avgRightPercent }}%</span>
            </div>
          </div>
          <div class="balance-center-marker"></div>
        </div>

        <div class="balance-side right" fxLayout="column" fxLayoutAlign="center start">
          <span class="balance-label">Right</span>
          <span class="balance-value" [class.dominant]="analysis.dominantSide === 'right'">
            {{ analysis.avgRightPercent }}%
          </span>
        </div>
      </div>

      <!-- Metrics Row -->
      <div class="balance-metrics" fxLayout="row" fxLayoutAlign="center center" fxLayoutGap="24px">
        <div class="metric" *ngIf="analysis.balanceStdDev > 0">
          <span class="metric-label">Variability</span>
          <span class="metric-value">σ {{ analysis.balanceStdDev }}%</span>
        </div>
        <div class="metric" *ngIf="analysis.consistencyScore > 0 && analysis.consistencyScore < 1">
          <span class="metric-label">Consistency</span>
          <span class="metric-value">{{ consistencyPercent }}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">Dominant Side</span>
          <span class="metric-value">{{ analysis.dominantSide | titlecase }}</span>
        </div>
      </div>

      <!-- Asymmetry Warning -->
      <div class="asymmetry-warning" *ngIf="analysis.hasSignificantAsymmetry">
        <mat-icon fontSet="material-icons-outlined" color="warn" inline="true">warning</mat-icon>
        <span>Significant asymmetry detected (>55/45). Consider a bike fit assessment.</span>
      </div>

      <!-- Per-interval Trend Chart -->
      <div *ngIf="analysis.intervalData?.length > 0" class="balance-chart">
        <plotly-plot
          [data]="chartData"
          [layout]="chartLayout"
          [config]="chartConfig"
          [useResizeHandler]="true"
          [style]="{ width: '100%', height: '250px' }"
        ></plotly-plot>
      </div>

      <!-- Contextual Notes -->
      <div class="balance-notes" *ngIf="analysis.notes?.length > 0">
        <mat-expansion-panel>
          <mat-expansion-panel-header>
            <mat-panel-title>
              <mat-icon fontSet="material-icons-outlined" inline="true">info</mat-icon>
              &nbsp;Balance Insights
            </mat-panel-title>
          </mat-expansion-panel-header>
          <div *ngFor="let note of analysis.notes" class="note-item">
            <p>{{ note }}</p>
          </div>
        </mat-expansion-panel>
      </div>
    </div>

    <!-- No data state -->
    <div class="power-balance-unavailable" *ngIf="!analysis && showUnavailable">
      <div fxLayout="column" fxLayoutAlign="center center" fxLayoutGap="8px">
        <p class="mat-caption">
          <mat-icon fontSet="material-icons-outlined" inline="true">info</mat-icon>
          No left/right balance data was found in this activity's FIT file.
        </p>
        <p class="mat-caption" style="max-width: 540px; text-align: center; opacity: 0.6;">
          Balance data is recorded by dual-sided power meters (e.g., dual-sided pedals or cranks) and also by some
          spider-based or crank-based meters whose firmware calculates it. If your power meter supports balance, ensure
          the FIT file includes it and re-sync the activity.
        </p>
      </div>
    </div>
  `,
  styles: [
    `
      .power-balance-container {
        padding: 16px 0;
      }

      .balance-description {
        max-width: 700px;
        opacity: 0.7;
        margin-bottom: 16px;
        line-height: 1.5;
      }

      .balance-overview {
        margin: 16px 0;
      }

      .balance-side {
        min-width: 80px;
      }

      .balance-label {
        font-size: 12px;
        opacity: 0.6;
        text-transform: uppercase;
      }

      .balance-value {
        font-size: 24px;
        font-weight: 500;
      }

      .balance-value.dominant {
        color: #1976d2;
      }

      .balance-bar-container {
        position: relative;
      }

      .balance-bar {
        display: flex;
        height: 32px;
        border-radius: 4px;
        overflow: hidden;
      }

      .balance-left-fill {
        background: #42a5f5;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 12px;
        font-weight: 500;
        transition: width 0.3s ease;
      }

      .balance-right-fill {
        background: #66bb6a;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 12px;
        font-weight: 500;
        transition: width 0.3s ease;
      }

      .balance-center-marker {
        position: absolute;
        top: -4px;
        left: 50%;
        width: 2px;
        height: 40px;
        background: rgba(0, 0, 0, 0.3);
        transform: translateX(-50%);
      }

      .balance-metrics {
        margin: 16px 0;
      }

      .metric {
        text-align: center;
      }

      .metric-label {
        display: block;
        font-size: 11px;
        opacity: 0.6;
        text-transform: uppercase;
      }

      .metric-value {
        font-size: 16px;
        font-weight: 500;
      }

      .asymmetry-warning {
        margin: 12px 0;
        padding: 8px 12px;
        border-radius: 4px;
        background: rgba(255, 152, 0, 0.1);
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .balance-chart {
        margin-top: 16px;
      }

      .balance-notes {
        margin-top: 16px;
      }

      .note-item p {
        margin: 4px 0;
        font-size: 13px;
      }

      .power-balance-unavailable {
        text-align: center;
        padding: 16px;
        opacity: 0.6;
      }
    `
  ]
})
export class ActivityViewPowerBalanceComponent implements OnInit {
  @Input()
  public activity: Activity;

  public analysis: PowerBalanceAnalysis | null;
  public showUnavailable: boolean;
  public consistencyPercent: number;
  public chartData: any[];
  public chartLayout: any;
  public chartConfig: any;

  constructor(
    @Inject(AppService) private readonly appService: AppService,
    @Inject(PlotlyService) private readonly plotlyService: PlotlyService
  ) {
    this.analysis = null;
    this.showUnavailable = false;
    this.consistencyPercent = 0;
    this.chartData = [];
    this.chartLayout = {};
    this.chartConfig = { displayModeBar: false, showTips: false, displaylogo: false };
  }

  public ngOnInit(): void {
    this.analyze();

    if (this.analysis?.intervalData?.length > 0) {
      this.buildChart();
    }

    this.appService.themeChanges$.subscribe(() => {
      if (this.analysis?.intervalData?.length > 0) {
        this.buildChart();
      }
    });
  }

  private analyze(): void {
    if (!this.activity) {
      return;
    }

    // Check if cycling dynamics balance data is available
    const dynamics = this.activity.stats?.dynamics?.cycling;
    if (dynamics) {
      this.analysis = LeftRightBalanceAnalyzer.analyzeFromDynamics(dynamics);
    }

    if (!this.analysis) {
      // Show unavailable message only for cycling activities
      this.showUnavailable = Activity.isRide(this.activity.type);
    } else {
      this.consistencyPercent = _.round(this.analysis.consistencyScore * 100, 0);
    }
  }

  private buildChart(): void {
    if (!this.analysis?.intervalData?.length) {
      return;
    }

    const intervals = this.analysis.intervalData;
    const isDark = this.appService.currentTheme === "dark";
    const textColor = isDark ? "white" : "black";
    const gridColor = isDark ? "#4d4d4d" : "#efefef";

    // Time labels (minutes)
    const timeLabels = intervals.map(d => _.round(d.startTime / 60, 0));

    // Left balance trace
    const leftTrace: any = {
      x: timeLabels,
      y: intervals.map(d => d.leftPercent),
      type: "scatter",
      mode: "lines",
      name: "Left %",
      line: { color: "#42a5f5", width: 2 },
      fill: "tozeroy",
      fillcolor: "rgba(66, 165, 245, 0.15)",
      hovertemplate: "L: %{y:.1f}%<br>Min %{x}<extra></extra>"
    };

    // 50% reference line
    const refLine: any = {
      x: [timeLabels[0], timeLabels[timeLabels.length - 1]],
      y: [50, 50],
      type: "scatter",
      mode: "lines",
      name: "50% reference",
      line: { color: "rgba(128, 128, 128, 0.5)", width: 1, dash: "dash" },
      showlegend: false,
      hoverinfo: "skip"
    };

    this.chartData = [leftTrace, refLine];

    this.chartLayout = {
      font: { size: 11, family: "Roboto", color: textColor },
      height: 250,
      margin: { t: 10, b: 40, l: 50, r: 20 },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      xaxis: {
        title: "Time (minutes)",
        gridcolor: gridColor,
        tickfont: { color: textColor }
      },
      yaxis: {
        title: "Left Balance %",
        range: [35, 65],
        gridcolor: gridColor,
        tickfont: { color: textColor },
        zeroline: false
      },
      legend: {
        orientation: "h",
        y: -0.25,
        font: { color: textColor }
      },
      hovermode: "x"
    };
  }
}
