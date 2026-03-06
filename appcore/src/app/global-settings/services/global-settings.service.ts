import { Injectable } from "@angular/core";
import { SectionModel } from "../models/section.model";
import { ListItemModel } from "../models/list-item.model";
import _ from "lodash";
import { MeasureSystem } from "@elevate/shared/enums/measure-system.enum";
import { Temperature } from "@elevate/shared/enums/temperature.enum";
import { BuildTarget } from "@elevate/shared/enums/build-target.enum";
import { MapBoxType } from "@elevate/shared/enums/mapbox-type.enum";

@Injectable()
export class GlobalSettingsService {
  public static readonly TYPE_OPTION_CHECKBOX: string = "checkbox";
  public static readonly TYPE_OPTION_LIST: string = "list";
  public static readonly TYPE_OPTION_NUMBER: string = "number";
  public static readonly TYPE_OPTION_TEXT: string = "text";
  private static readonly FITNESS_PERIOD_OPTIONS: ListItemModel[] = [
    { key: "7_days", name: "7 days" },
    { key: "14_days", name: "14 days" },
    { key: "month", name: "30 days" },
    { key: "6_weeks", name: "6 weeks" },
    { key: "2_months", name: "2 months" },
    { key: "3_months", name: "3 months" },
    { key: "4_months", name: "4 months" },
    { key: "5_months", name: "5 months" },
    { key: "6_months", name: "6 months" },
    { key: "9_months", name: "9 months" },
    { key: "12_months", name: "12 months" },
    { key: "24_months", name: "24 months" },
    { key: "beginning", name: "Since beginning" }
  ];
  private static readonly FITNESS_SMOOTHING_OPTIONS: ListItemModel[] = [0, 2, 3, 4, 5, 7, 10, 14, 20, 30].map(
    value => ({ key: String(value), name: value === 0 ? "None" : `${value} days` })
  );
  private static readonly ACTIVITY_SMOOTHING_OPTIONS: ListItemModel[] = [
    0, 2, 5, 10, 15, 20, 30, 60, 120, 180, 300
  ].map(value => ({
    key: String(value),
    name: value === 0 ? "None" : value < 60 ? `${value} sec` : `${value / 60} min`
  }));
  private static readonly ACTIVITY_SCALE_OPTIONS: ListItemModel[] = [
    { key: "distance", name: "Distance" },
    { key: "time", name: "Time" }
  ];

  public readonly sections: SectionModel[] = [
    {
      title: "Units",
      options: [
        {
          key: "systemUnit",
          disableHelper: true,
          type: "list",
          labels: ["All"],
          list: [
            {
              key: MeasureSystem.METRIC,
              name: _.startCase(MeasureSystem.METRIC)
            },
            {
              key: MeasureSystem.IMPERIAL,
              name: _.startCase(MeasureSystem.IMPERIAL)
            }
          ] as ListItemModel[],
          title: "App system units"
        },
        {
          key: "temperatureUnit",
          disableHelper: true,
          type: "list",
          labels: ["All"],
          list: [
            {
              key: Temperature.FAHRENHEIT,
              name: "Fahrenheit"
            },
            {
              key: Temperature.CELSIUS,
              name: "Celsius"
            }
          ] as ListItemModel[],
          title: "Temperature"
        }
      ]
    },
    {
      title: "Activity View",
      buildTarget: BuildTarget.DESKTOP,
      options: [
        {
          key: "defaultMapType",
          disableHelper: true,
          title: "Default map type",
          type: "list",
          labels: ["All"],
          list: _.keys(MapBoxType).map(mapTypeKey => {
            return { name: _.startCase(mapTypeKey.toLowerCase()), key: MapBoxType[mapTypeKey] };
          })
        },
        {
          key: "mapToken",
          title: "Personal Mapbox Token",
          type: "text",
          labels: ["All"]
        }
      ]
    },
    {
      title: "Activity Analysis Graph defaults",
      buildTarget: BuildTarget.DESKTOP,
      options: [
        {
          key: "activityGraphDefaultShowGraph",
          type: "checkbox",
          title: "Open analysis graph automatically",
          labels: ["All"],
          disableHelper: true
        },
        {
          key: "activityGraphDefaultScale",
          type: "list",
          title: "Default analysis graph scale",
          labels: ["All"],
          list: GlobalSettingsService.ACTIVITY_SCALE_OPTIONS,
          disableHelper: true
        },
        {
          key: "activityGraphDefaultSmoothingSeconds",
          type: "list",
          title: "Default analysis graph smoothing",
          labels: ["All"],
          list: GlobalSettingsService.ACTIVITY_SMOOTHING_OPTIONS,
          disableHelper: true
        },
        {
          key: "activityGraphDefaultShowElevation",
          type: "checkbox",
          title: "Show Elevation series by default",
          labels: ["Cycling", "Running"],
          disableHelper: true
        },
        {
          key: "activityGraphDefaultShowSpeed",
          type: "checkbox",
          title: "Show Speed/Pace series by default",
          labels: ["Cycling", "Running"],
          disableHelper: true
        },
        {
          key: "activityGraphDefaultShowHeartRate",
          type: "checkbox",
          title: "Show Heart Rate series by default",
          labels: ["Cycling", "Running"],
          disableHelper: true
        },
        {
          key: "activityGraphDefaultShowPower",
          type: "checkbox",
          title: "Show Power series by default",
          labels: ["Cycling", "Running"],
          disableHelper: true
        },
        {
          key: "activityGraphDefaultShowCadence",
          type: "checkbox",
          title: "Show Cadence series by default",
          labels: ["Cycling", "Running"],
          disableHelper: true
        }
      ]
    },
    {
      title: "Fitness Trend defaults",
      buildTarget: BuildTarget.DESKTOP,
      options: [
        {
          key: "fitnessTrendDefaultPeriod",
          type: "list",
          title: "Default fitness screen time range",
          labels: ["Fitness", "FTP", "Running Threshold"],
          list: GlobalSettingsService.FITNESS_PERIOD_OPTIONS,
          disableHelper: true
        },
        {
          key: "fitnessTrendDefaultSmoothingDays",
          type: "list",
          title: "Default fitness graph smoothing",
          labels: ["Fitness"],
          list: GlobalSettingsService.FITNESS_SMOOTHING_OPTIONS,
          disableHelper: true
        },
        {
          key: "fitnessTrendDefaultShowTrainingZones",
          type: "checkbox",
          title: "Enable training zones overlay by default",
          labels: ["Fitness"],
          disableHelper: true
        },
        {
          key: "fitnessTrendDefaultUsePowerMeter",
          type: "checkbox",
          title: "Include power-meter activities by default",
          labels: ["Fitness"],
          disableHelper: true
        },
        {
          key: "fitnessTrendDefaultIncludeSwim",
          type: "checkbox",
          title: "Include swim activities by default",
          labels: ["Fitness"],
          disableHelper: true
        },
        {
          key: "fitnessTrendDefaultIncludeEBikeRides",
          type: "checkbox",
          title: "Include e-bike rides by default",
          labels: ["Fitness"],
          disableHelper: true
        },
        {
          key: "fitnessTrendDefaultExcludeIndoorTrainerFtp",
          type: "checkbox",
          title: "Exclude indoor trainer rides from FTP trend by default",
          labels: ["FTP"],
          disableHelper: true
        }
      ]
    },
    {
      title: "History consistency warnings",
      options: [
        {
          key: "disableMissingStressScoresWarning",
          type: "checkbox",
          title: 'Disable <i>"Missing stress scores detected..."</i> warnings <strong>(not recommended)</strong>',
          labels: ["All"],
          disableHelper: true
        },
        {
          key: "disableActivitiesNeedRecalculationWarning",
          type: "checkbox",
          title:
            'Disable <i>"Some of your activities need to be recalculated..."</i> warnings <strong>(not recommended)</strong>',
          labels: ["All"],
          disableHelper: true
        }
      ]
    },
    {
      title: "Activities Extended Statistics",
      buildTarget: BuildTarget.EXTENSION,
      options: [
        {
          key: "displayActivityRatio",
          type: "checkbox",
          title: "Move Ratio stat",
          labels: ["Cycling", "Running"]
        },
        {
          key: "displayAdvancedPowerData",
          type: "checkbox",
          title: "Power stats",
          labels: ["Cycling", "Running"]
        },
        {
          key: "displayAdvancedHrData",
          type: "checkbox",
          title: "Heart rate stats",
          labels: ["Cycling", "Running"]
        },
        {
          key: "displayAdvancedSpeedData",
          type: "checkbox",
          title: "Speed/Pace stats",
          labels: ["Cycling", "Running"]
        },
        {
          key: "displayCadenceData",
          type: "checkbox",
          title: "Cadence stats",
          labels: ["Cycling", "Running"]
        },
        {
          key: "displayAdvancedGradeData",
          type: "checkbox",
          title: "Grade stats",
          labels: ["Cycling", "Running"]
        },
        {
          key: "displayAdvancedElevationData",
          type: "checkbox",
          title: "Elevation stats",
          labels: ["Cycling", "Running"]
        }
      ]
    },
    {
      title: "Activity viewing options",
      buildTarget: BuildTarget.EXTENSION,
      options: [
        {
          key: "enableBothLegsCadence",
          type: "checkbox",
          title: "Enable both legs extended cadence data",
          labels: ["Running"]
        },
        {
          key: "displayBikeOdoInActivity",
          type: "checkbox",
          title: "Enable bike odo display",
          labels: ["Cycling"]
        },
        {
          key: "displayRunningPerformanceIndex",
          type: "checkbox",
          title: "Display running performance index",
          labels: ["Running"]
        },
        {
          key: "activateRunningGradeAdjustedPace",
          type: "checkbox",
          title: "Enable Grade Adjusted Pace graph",
          labels: ["Running"]
        },
        {
          key: "activateRunningHeartRate",
          type: "checkbox",
          title: "Enable Heart Rate graph",
          labels: ["Running"]
        },
        {
          key: "activateRunningTemperature",
          type: "checkbox",
          title: "Enable Temperature graph",
          labels: ["Running"]
        },
        {
          key: "activateRunningCadence",
          type: "checkbox",
          title: "Enable Cadence graph",
          labels: ["Running"]
        },
        {
          key: "activityStravaMapType",
          type: "list",
          labels: ["All"],
          list: [
            {
              key: "terrain",
              name: "Terrain"
            },
            {
              key: "standard",
              name: "Standard"
            },
            {
              key: "satellite",
              name: "Satellite"
            }
          ] as ListItemModel[],
          title: "Default Strava Map type displayed in activities"
        },
        {
          key: "displaySegmentTimeComparisonToKOM",
          type: "checkbox",
          title: "Enabled segment time comparison to KOM/QOM display",
          labels: ["All"]
        },
        {
          key: "displaySegmentTimeComparisonToPR",
          type: "checkbox",
          title: "Enabled segment time comparison to PR display",
          labels: ["All"]
        },
        {
          key: "displaySegmentTimeComparisonToCurrentYearPR",
          type: "checkbox",
          title: "Enabled segment time comparison to current year PR display",
          labels: ["All"]
        },
        {
          key: "displaySegmentTimeComparisonPosition",
          type: "checkbox",
          title: "Enabled segment time comparison rank column",
          labels: ["All"]
        },
        {
          key: "reviveGoogleMaps",
          type: "checkbox",
          title: "Revive Google Maps on activities",
          labels: ["All"],
          enableSubOption: ["reviveGoogleMapsLayerType"],
          hidden: true // Google map feature marked as hidden until it come back
        },
        {
          key: "reviveGoogleMapsLayerType",
          type: "list",
          labels: ["All"],
          list: [
            {
              key: "roadmap",
              name: "Roadmap"
            },
            {
              key: "satellite",
              name: "Satellite"
            },
            {
              key: "hybrid",
              name: "Satellite + Legends"
            },
            {
              key: "terrain",
              name: "Terrain"
            }
          ] as ListItemModel[],
          title: "Default Google Maps layer type",
          hidden: true // Google map feature marked as hidden until it come back
        },
        {
          key: "displayActivityBestSplits",
          type: "checkbox",
          title: "Enable best splits into your cycling activities",
          labels: ["Cycling"]
        },
        {
          key: "defaultLeaderBoardFilter",
          type: "list",
          labels: ["All"],
          list: [
            {
              key: "overall",
              name: "Overall"
            },
            {
              key: "men",
              name: "Men"
            },
            {
              key: "women",
              name: "Women"
            },
            {
              key: "following",
              name: "Following"
            },
            {
              key: "my_results",
              name: "My Results"
            }
          ] as ListItemModel[],
          title: "Default Leaderboard Filter"
        },
        {
          key: "displayWindyOverlay",
          type: "checkbox",
          title: "Display Wind, Temp, Clouds & Humidity overlay of your cycling activity",
          labels: ["Cycling"]
        }
      ]
    },
    {
      title: "Segments viewing options",
      buildTarget: BuildTarget.EXTENSION,
      options: [
        {
          key: "displaySegmentRankPercentage",
          type: "checkbox",
          title: "Segment Rank %",
          labels: ["All"]
        },
        {
          key: "displayNearbySegments",
          type: "checkbox",
          title: "Nearby Segments",
          labels: ["Cycling", "Running"]
        }
      ]
    },
    {
      title: "Activities and Segments viewing options",
      buildTarget: BuildTarget.EXTENSION,
      options: [
        {
          key: "remoteLinks",
          type: "checkbox",
          title: "Enable Veloviewer & Segment details remote views",
          labels: ["All"]
        }
      ]
    },
    {
      title: "Dashboard",
      buildTarget: BuildTarget.EXTENSION,
      options: [
        {
          key: "feedChronologicalOrder",
          type: "checkbox",
          title: "Organize activity feed chronologically",
          labels: ["All"]
        },
        {
          key: "feedHideChallenges",
          type: "checkbox",
          title: "Hide challenges",
          labels: ["All"]
        },
        {
          key: "feedHideCreatedRoutes",
          type: "checkbox",
          title: "Hide created routes",
          labels: ["All"]
        },
        {
          key: "feedHidePosts",
          type: "checkbox",
          title: "Hide posts",
          labels: ["All"]
        },
        {
          key: "feedHideSuggestedAthletes",
          type: "checkbox",
          title: "Hide suggested athletes",
          labels: ["All"]
        },
        {
          key: "feedHideVirtualRides",
          type: "checkbox",
          title: "Hide virtual rides.",
          labels: ["Cycling"],
          min: 0
        },
        {
          key: "feedHideRideActivitiesUnderDistance",
          type: "number",
          title: "Hide rides activities under distance.",
          labels: ["Cycling"],
          min: 0
        },
        {
          key: "feedHideRunActivitiesUnderDistance",
          type: "number",
          title: "Hide running activities under distance.",
          labels: ["Running"],
          min: 0
        }
      ]
    },
    {
      title: "Hidden/Beta features",
      buildTarget: BuildTarget.EXTENSION,
      options: [
        {
          key: "showHiddenBetaFeatures",
          type: "checkbox",
          title: "Enable Hidden/Beta features",
          labels: ["All"],
          enableSubOption: ["displayRecentEffortsHRAdjustedPacePower"]
        },
        {
          key: "displayRecentEffortsHRAdjustedPacePower",
          type: "checkbox",
          title:
            "Display running estimated paces & cycling estimated powers from most painful effort on a segment (Experimental)",
          labels: ["Cycling", "Running"]
        }
      ]
    }
  ];

  public getSectionsByBuildTarget(buildTarget: BuildTarget): SectionModel[] {
    const filteredSections: SectionModel[] = [];

    _.forEach(this.sections, section => {
      if (_.isUndefined(section.buildTarget)) {
        filteredSections.push(section);
      } else {
        if (section.buildTarget === buildTarget) {
          filteredSections.push(section);
        }
      }
    });

    return filteredSections;
  }
}
