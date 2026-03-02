import { Component, Inject, Input, OnChanges, OnInit, SimpleChanges } from "@angular/core";
import _ from "lodash";
import { AppService } from "../../shared/services/app-service/app.service";
import { Theme } from "../../shared/enums/theme.enum";
import { RunningThresholdTrendPoint } from "@elevate/shared/models/ftp-estimate.model";

/**
 * Running Threshold Trend Graph Component.
 *
 * Displays historical running threshold pace (and optionally power) as an
 * interactive Plotly line chart. The pace axis is intentionally inverted so
 * that "up" always means "faster / fitter". A secondary y-axis shows running
 * threshold power when Stryd data is available.
 */
@Component({
    selector: "app-running-threshold-graph",
    template: `
    <div class="run-threshold-container" *ngIf="trendPoints?.length > 0">
      <p class="mat-caption run-description">
        Estimated from your runs using Grade Adjusted Pace (GAP) and heart rate — terrain is already corrected. Runs
        closer to your lactate threshold HR contribute more weight. A Stryd power meter adds a parallel power-based
        estimate.
      </p>

      <div class="run-summary" *ngIf="currentEstimate" fxLayout="row" fxLayoutAlign="start center" fxLayoutGap="16px">
        <div>
          <span class="run-pace">{{ formatPace(currentEstimate.thresholdPaceSec) }}</span>
          <span class="run-unit">/km</span>
        </div>
        <div *ngIf="currentEstimate.thresholdPower">
          <span class="run-power">{{ currentEstimate.thresholdPower }}</span>
          <span class="run-unit">W</span>
        </div>
        <mat-chip-list>
          <mat-chip [color]="confidenceChipColor" selected>
            {{ currentEstimate.confidenceLabel | titlecase }} confidence
          </mat-chip>
        </mat-chip-list>
      </div>

      <plotly-plot
        *ngIf="chartData?.length > 0"
        [data]="chartData"
        [layout]="chartLayout"
        [config]="chartConfig"
        [useResizeHandler]="true"
        [style]="{ width: '100%', height: '300px' }"
      ></plotly-plot>

      <div class="run-details-panel" *ngIf="selectedPoint">
        <mat-card class="selected-point-card">
          <mat-card-content>
            <div fxLayout="row" fxLayoutAlign="space-between center">
              <div>
                <strong>{{ selectedPoint.date }}</strong>
                — Threshold pace: <strong>{{ formatPace(selectedPoint.thresholdPaceSec) }}/km</strong>
                <span *ngIf="selectedPoint.thresholdPower"> · <strong>{{ selectedPoint.thresholdPower }}W</strong></span>
              </div>
              <div>
                <span class="mat-caption">
                  {{ selectedPoint.activityCount }} runs contributed &bull;
                  {{ selectedPoint.confidenceLabel | titlecase }} confidence ({{ selectedPoint.confidence }}%)
                </span>
              </div>
            </div>
          </mat-card-content>
        </mat-card>
      </div>
    </div>

    <div class="run-threshold-empty" *ngIf="!trendPoints || trendPoints.length === 0">
      <mat-card>
        <mat-card-content>
          <div fxLayout="column" fxLayoutAlign="center center" fxLayoutGap="8px">
            <div fxLayout="row" fxLayoutAlign="center center" fxLayoutGap="8px">
              <mat-icon fontSet="material-icons-outlined" color="accent">directions_run</mat-icon>
              <span>
                Running threshold estimation requires runs of at least 30 minutes with a heart rate monitor, or a Stryd
                power meter. Keep running and your threshold trend will appear here once you have 2+ qualifying runs.
              </span>
            </div>
            <p class="mat-caption" style="max-width: 600px; text-align: center;">
              No dedicated time-trial needed — Elevate uses your Grade Adjusted Pace and heart rate from every run to
              extrapolate your lactate threshold pace. Runs at higher effort levels (closer to threshold) contribute
              more weight to the estimate.
            </p>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `,
    styles: [
        `
      .run-threshold-container {
        padding: 16px 0;
      }

      .run-summary {
        margin-bottom: 12px;
      }

      .run-pace {
        font-size: 2em;
        font-weight: 700;
        letter-spacing: -0.5px;
      }

      .run-power {
        font-size: 1.4em;
        font-weight: 600;
      }

      .run-unit {
        font-size: 0.9em;
        opacity: 0.7;
        margin-left: 2px;
      }

      .run-description {
        opacity: 0.75;
        margin-bottom: 12px;
      }

      .selected-point-card {
        margin-top: 8px;
      }

      .run-threshold-empty mat-card {
        background: transparent;
        box-shadow: none;
        border: 1px dashed rgba(127, 127, 127, 0.35);
      }
    `
    ]
})
export class RunningThresholdGraphComponent implements OnInit, OnChanges {
    @Input() public trendPoints: RunningThresholdTrendPoint[] = [];

    public currentEstimate: RunningThresholdTrendPoint | null = null;
    public selectedPoint: RunningThresholdTrendPoint | null = null;
    public chartData: Partial<Plotly.Data>[] = [];
    public chartLayout: Partial<Plotly.Layout> = {};
    public chartConfig: Partial<Plotly.Config> = { responsive: true, displayModeBar: false };
    public confidenceChipColor: string = "primary";

    private isDarkTheme: boolean = false;

    constructor(@Inject(AppService) private readonly appService: AppService) { }

    public ngOnInit(): void {
        this.isDarkTheme = this.appService?.currentTheme === Theme.DARK;
        this.buildChart();
    }

    public ngOnChanges(changes: SimpleChanges): void {
        if (changes.trendPoints) {
            this.buildChart();
        }
    }

    /** Format seconds-per-km as mm:ss */
    public formatPace(secPerKm: number): string {
        if (!secPerKm || secPerKm <= 0) return "--:--";
        const mins = Math.floor(secPerKm / 60);
        const secs = Math.round(secPerKm % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    }

    private buildChart(): void {
        if (!this.trendPoints?.length) {
            this.chartData = [];
            this.currentEstimate = null;
            return;
        }

        this.currentEstimate = this.trendPoints[this.trendPoints.length - 1];

        this.confidenceChipColor =
            this.currentEstimate.confidenceLabel === "high" ? "primary" :
                this.currentEstimate.confidenceLabel === "moderate" ? "accent" : "warn";

        const isDark = this.isDarkTheme;
        const lineColor = isDark ? "#80cbc4" : "#00897b";       // teal
        const powerColor = isDark ? "#ffb74d" : "#f57c00";      // amber
        const bandColor = isDark ? "rgba(128,203,196,0.18)" : "rgba(0,137,123,0.12)";
        const textColor = isDark ? "#e0e0e0" : "#424242";
        const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";

        const dates = this.trendPoints.map(p => p.date);
        // Pace in minutes (as float for Plotly) — inverted axis means lower = faster
        const paceValues = this.trendPoints.map(p => _.round(p.thresholdPaceSec / 60, 4));
        const powerValues = this.trendPoints.map(p => p.thresholdPower);
        const hasAnyPower = powerValues.some(v => v != null && v > 0);

        // Confidence band: ±5% of pace from confidence score
        // High confidence (>70) → ±1%, low confidence (<20) → ±8%
        const upperBand = this.trendPoints.map(p => {
            const margin = _.round(((1 - p.confidence / 100) * 0.08 + 0.01) * (p.thresholdPaceSec / 60), 4);
            return _.round(p.thresholdPaceSec / 60 + margin, 4);
        });
        const lowerBand = this.trendPoints.map(p => {
            const margin = _.round(((1 - p.confidence / 100) * 0.08 + 0.01) * (p.thresholdPaceSec / 60), 4);
            return _.round(Math.max(0, p.thresholdPaceSec / 60 - margin), 4);
        });

        // Custom hover: display as mm:ss
        const hoverText = this.trendPoints.map(p =>
            `${p.date}<br>Threshold: <b>${this.formatPace(p.thresholdPaceSec)}/km</b>` +
            (p.thresholdPower ? `<br>Power: <b>${p.thresholdPower}W</b>` : "") +
            `<br>${p.activityCount} runs · ${p.confidenceLabel} confidence`
        );

        // Y-axis tick format: convert float minutes back to mm:ss
        const paceMin = Math.min(...paceValues);
        const paceMax = Math.max(...upperBand);
        const paceTickVals = this.generatePaceTicks(paceMin * 60, paceMax * 60);

        this.chartData = [
            // Upper band (fill to next)
            {
                x: dates,
                y: upperBand,
                type: "scatter",
                mode: "lines",
                line: { width: 0, color: "transparent" },
                showlegend: false,
                hoverinfo: "skip",
                fill: "none",
                yaxis: "y"
            } as any,
            // Lower band (fill to previous)
            {
                x: dates,
                y: lowerBand,
                type: "scatter",
                mode: "lines",
                fill: "tonexty",
                fillcolor: bandColor,
                line: { width: 0, color: "transparent" },
                showlegend: false,
                hoverinfo: "skip",
                yaxis: "y"
            } as any,
            // Pace main line
            {
                x: dates,
                y: paceValues,
                type: "scatter",
                mode: "lines+markers",
                name: "Threshold pace",
                line: { color: lineColor, width: 2.5, shape: "spline", smoothing: 0.6 },
                marker: { color: lineColor, size: 4 },
                hovertext: hoverText,
                hoverinfo: "text",
                yaxis: "y"
            } as any,
            // Power line (secondary axis, shown only when Stryd data exists)
            ...(hasAnyPower ? [{
                x: dates,
                y: powerValues,
                type: "scatter",
                mode: "lines",
                name: "Threshold power (W)",
                line: { color: powerColor, width: 1.5, dash: "dot", shape: "spline", smoothing: 0.6 },
                hoverinfo: "skip",
                yaxis: "y2"
            } as any] : [])
        ];

        this.chartLayout = {
            paper_bgcolor: "transparent",
            plot_bgcolor: "transparent",
            font: { color: textColor, size: 11 },
            margin: { t: 10, r: hasAnyPower ? 60 : 20, b: 40, l: 60 },
            xaxis: {
                type: "date",
                gridcolor: gridColor,
                showgrid: true,
                tickformat: "%b %Y"
            },
            // Y-axis for pace (inverted: lower s/km = faster = higher on chart)
            yaxis: {
                autorange: "reversed",
                gridcolor: gridColor,
                showgrid: true,
                tickvals: paceTickVals.map(s => _.round(s / 60, 4)),
                ticktext: paceTickVals.map(s => this.formatPace(s)),
                title: { text: "Threshold pace", font: { size: 10 } }
            } as any,
            // Secondary y-axis for power (normal direction: higher = better)
            ...(hasAnyPower ? {
                yaxis2: {
                    overlaying: "y",
                    side: "right",
                    showgrid: false,
                    gridcolor: "transparent",
                    title: { text: "Power (W)", font: { size: 10, color: powerColor } },
                    tickfont: { color: powerColor, size: 10 }
                } as any
            } : {}),
            showlegend: hasAnyPower,
            legend: { x: 0, y: 1, orientation: "h" },
            hovermode: "x unified"
        } as any;
    }

    /** Generate evenly spaced pace ticks (every 30s) between min and max */
    private generatePaceTicks(minSec: number, maxSec: number): number[] {
        const step = 30; // 30 second steps
        const start = Math.floor(minSec / step) * step;
        const end = Math.ceil(maxSec / step) * step;
        const ticks: number[] = [];
        for (let s = start; s <= end; s += step) {
            ticks.push(s);
        }
        return ticks;
    }
}
