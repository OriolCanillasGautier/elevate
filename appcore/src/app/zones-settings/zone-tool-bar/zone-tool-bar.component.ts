import { Component, EventEmitter, Inject, Input, OnInit, Output } from "@angular/core";
import { ZonesService } from "../shared/zones.service";
import { MatDialog } from "@angular/material/dialog";
import { MatSnackBar } from "@angular/material/snack-bar";
import { ZonesImportExportDialogComponent } from "../zones-import-export-dialog/zones-import-export-dialog.component";
import { ConfirmDialogComponent } from "../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { ConfirmDialogDataModel } from "../../shared/dialogs/confirm-dialog/confirm-dialog-data.model";
import { ZoneImportExportDataModel } from "../zones-import-export-dialog/zone-import-export-data.model";
import { Mode } from "../zones-import-export-dialog/mode.enum";
import { ZoneDefinitionModel } from "../../shared/models/zone-definition.model";
import { LoggerService } from "../../shared/services/logging/logger.service";
import { AthleteService } from "../../shared/services/athlete/athlete.service";
import { AthleteModel } from "@elevate/shared/models/athlete/athlete.model";
import { ZoneModel } from "@elevate/shared/models/zone.model";
import { ZoneType } from "@elevate/shared/enums/zone-type.enum";

@Component({
  selector: "app-zone-tool-bar",
  templateUrl: "./zone-tool-bar.component.html",
  styleUrls: ["./zone-tool-bar.component.scss"]
})
export class ZoneToolBarComponent implements OnInit {
  @Input()
  public currentZonesLength: number;

  @Input()
  public zoneDefinitions: ZoneDefinitionModel[];

  @Input()
  public zoneDefinitionSelected: ZoneDefinitionModel;

  @Output()
  public zoneDefinitionSelectedChange: EventEmitter<ZoneDefinitionModel> = new EventEmitter<ZoneDefinitionModel>();

  constructor(
    @Inject(ZonesService) public readonly zonesService: ZonesService,
    @Inject(MatDialog) private readonly dialog: MatDialog,
    @Inject(MatSnackBar) private readonly snackBar: MatSnackBar,
    @Inject(LoggerService) private readonly logger: LoggerService,
    @Inject(AthleteService) private readonly athleteService: AthleteService
  ) {}

  public ngOnInit(): void {}

  public get canAutoCalculate(): boolean {
    const type = this.zoneDefinitionSelected?.value as ZoneType;
    return type === ZoneType.HEART_RATE || type === ZoneType.POWER || type === ZoneType.RUNNING_POWER;
  }

  public onAutoCalculateZones(): void {
    this.athleteService.fetch().then((athleteModel: AthleteModel) => {
      const settings = athleteModel.getCurrentSettings();
      const type = this.zoneDefinitionSelected.value as ZoneType;
      let zones: ZoneModel[] | null = null;

      if (type === ZoneType.HEART_RATE) {
        const maxHr = settings?.maxHr;
        if (!maxHr || maxHr <= 0) {
          this.popSnack("No Max HR found. Please set it in your athlete profile first.");
          return;
        }
        // 5-zone Coggan model as % of maxHr: 50/60/70/80/90/100%
        const breakpoints = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map(p => Math.round(p * maxHr));
        zones = [];
        for (let i = 0; i < breakpoints.length - 1; i++) {
          zones.push({ from: breakpoints[i], to: breakpoints[i + 1] });
        }
      } else if (type === ZoneType.POWER || type === ZoneType.RUNNING_POWER) {
        const ftp = type === ZoneType.RUNNING_POWER ? settings?.runningFtp : settings?.cyclingFtp;
        if (!ftp || ftp <= 0) {
          const label = type === ZoneType.RUNNING_POWER ? "Running FTP" : "Cycling FTP";
          this.popSnack(`No ${label} found. Please set it in your athlete profile first.`);
          return;
        }
        // 7-zone Coggan model (% of FTP): <55/55-75/75-90/90-105/105-120/120-150/>150%
        const breakpoints = [0, 0.55, 0.75, 0.9, 1.05, 1.2, 1.5, 2.0].map(p => (p === 0 ? 0 : Math.round(p * ftp)));
        zones = [];
        for (let i = 0; i < breakpoints.length - 1; i++) {
          zones.push({ from: breakpoints[i], to: breakpoints[i + 1] });
        }
      }

      if (!zones) {
        return;
      }

      this.zonesService.currentZones = zones;
      this.zonesService.updateZones().then(
        () => {
          this.zonesService.zonesUpdates.next(zones);
          this.popSnack("Zones auto-calculated from your athlete profile.");
        },
        error => {
          this.logger.error(error);
          this.popSnack(error);
        }
      );
    });
  }

  public onZoneDefinitionSelected(): void {
    // Notify parent ZonesSettings component of new zone definition selected
    this.zoneDefinitionSelectedChange.emit(this.zoneDefinitionSelected);
  }

  public onStepChange(): void {
    this.zonesService.notifyStepChange(this.zoneDefinitionSelected.step);
  }

  public onAddLastZone(): void {
    this.zonesService.addLastZone().then(
      message => this.popSnack(message),
      error => {
        this.logger.warn(error);
        this.popSnack(error);
      }
    );
  }

  public onRemoveLastZone(): void {
    this.zonesService.removeLastZone().then(
      message => this.popSnack(message),
      error => {
        this.logger.warn(error);
        this.popSnack(error);
      }
    );
  }

  public onResetZonesToDefault(): void {
    const data: ConfirmDialogDataModel = {
      title: "Reset <" + this.zonesService.zoneDefinition.name + "> zones",
      content: "Are you sure? Previous data will be lost."
    };

    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      minWidth: ConfirmDialogComponent.MIN_WIDTH,
      maxWidth: ConfirmDialogComponent.MAX_WIDTH,
      data: data
    });

    const afterClosedSubscription = dialogRef.afterClosed().subscribe((confirm: boolean) => {
      if (confirm) {
        this.zonesService.resetZonesToDefault().then(
          () => {
            this.popSnack(this.zonesService.zoneDefinition.name + " zones have been set to default");
          },
          error => {
            this.logger.error(error);
            this.popSnack(error);
          }
        );
      }
      afterClosedSubscription.unsubscribe();
    });
  }

  public onImportZones() {
    const importExportData: ZoneImportExportDataModel = {
      zoneDefinition: this.zonesService.zoneDefinition,
      mode: Mode.IMPORT
    };

    this.dialog.open(ZonesImportExportDialogComponent, {
      minWidth: ZonesImportExportDialogComponent.MIN_WIDTH,
      maxWidth: ZonesImportExportDialogComponent.MAX_WIDTH,
      data: importExportData
    });
  }

  public onExportZones() {
    const importExportData: ZoneImportExportDataModel = {
      zoneDefinition: this.zonesService.zoneDefinition,
      zonesData: this.zonesService.currentZones,
      mode: Mode.EXPORT
    };

    this.dialog.open(ZonesImportExportDialogComponent, {
      minWidth: ZonesImportExportDialogComponent.MIN_WIDTH,
      maxWidth: ZonesImportExportDialogComponent.MAX_WIDTH,
      data: importExportData
    });
  }

  private popSnack(message: string): void {
    this.snackBar.open(message, "Close", { duration: 2500 });
  }
}
