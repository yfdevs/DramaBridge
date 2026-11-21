import type { ComponentProps } from "react";
import activity from "@iconify-icons/solar/pulse-linear";
import arrowDown from "@iconify-icons/solar/arrow-down-linear";
import arrowDownToLine from "@iconify-icons/solar/arrow-down-to-line-linear";
import browser from "@iconify-icons/solar/window-frame-linear";
import calendar from "@iconify-icons/solar/calendar-linear";
import chartBar from "@iconify-icons/solar/chart-linear";
import check from "@iconify-icons/solar/check-linear";
import checkCircle from "@iconify-icons/solar/check-circle-linear";
import checklist from "@iconify-icons/solar/checklist-minimalistic-linear";
import checklistSelected from "@iconify-icons/solar/checklist-minimalistic-bold";
import chevronDown from "@iconify-icons/solar/alt-arrow-down-linear";
import chevronLeft from "@iconify-icons/solar/alt-arrow-left-linear";
import chevronRight from "@iconify-icons/solar/alt-arrow-right-linear";
import chevronUp from "@iconify-icons/solar/alt-arrow-up-linear";
import chevronsLeft from "@iconify-icons/solar/double-alt-arrow-left-linear";
import chevronsRight from "@iconify-icons/solar/double-alt-arrow-right-linear";
import circle from "@iconify-icons/solar/circle-linear";
import circleAlert from "@iconify-icons/solar/danger-circle-linear";
import circleDashed from "@iconify-icons/solar/circle-dashed-linear";
import close from "@iconify-icons/solar/close-linear";
import cloudDownload from "@iconify-icons/solar/cloud-download-linear";
import cloudUpload from "@iconify-icons/solar/cloud-upload-linear";
import copy from "@iconify-icons/solar/copy-linear";
import dangerTriangle from "@iconify-icons/solar/danger-triangle-linear";
import download from "@iconify-icons/solar/download-linear";
import error from "@iconify-icons/solar/close-square-linear";
import externalLink from "@iconify-icons/solar/arrow-right-up-linear";
import fileText from "@iconify-icons/solar/file-text-linear";
import filter from "@iconify-icons/solar/filter-linear";
import fineTune from "@iconify-icons/solar/tuning-linear";
import folder from "@iconify-icons/solar/folder-linear";
import folderOpen from "@iconify-icons/solar/folder-open-linear";
import gitBranch from "@iconify-icons/solar/git-branch-linear";
import globe from "@iconify-icons/solar/global-linear";
import hardDrive from "@iconify-icons/solar/ssd-square-linear";
import info from "@iconify-icons/solar/info-circle-linear";
import list from "@iconify-icons/solar/list-linear";
import listChecks from "@iconify-icons/solar/list-check-linear";
import loader from "@iconify-icons/solar/loader-linear";
import minus from "@iconify-icons/solar/minus-linear";
import moon from "@iconify-icons/solar/moon-linear";
import moreHorizontal from "@iconify-icons/solar/menu-dots-linear";
import panelLeft from "@iconify-icons/solar/panel-left-close-linear";
import pause from "@iconify-icons/solar/pause-linear";
import play from "@iconify-icons/solar/play-linear";
import power from "@iconify-icons/solar/power-linear";
import refresh from "@iconify-icons/solar/refresh-linear";
import restart from "@iconify-icons/solar/restart-linear";
import scissors from "@iconify-icons/solar/scissors-linear";
import search from "@iconify-icons/solar/magnifier-linear";
import settings from "@iconify-icons/solar/settings-linear";
import stopCircle from "@iconify-icons/solar/stop-circle-linear";
import sun from "@iconify-icons/solar/sun-linear";
import terminal from "@iconify-icons/solar/code-square-linear";
import trash from "@iconify-icons/solar/trash-bin-minimalistic-linear";
import undo from "@iconify-icons/solar/undo-left-linear";
import userSearch from "@iconify-icons/solar/user-circle-linear";
import wrapText from "@iconify-icons/solar/list-indent-decrease-linear";

type SolarIconProps = ComponentProps<"svg"> & { size?: number | string };
export type SolarIcon = (props: SolarIconProps) => React.JSX.Element;

function createSolarIcon({ body, width = 24, height = 24 }: typeof activity): SolarIcon {
  return function SolarIcon({ size = 24, children: _children, ...props }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        {...props}
        dangerouslySetInnerHTML={{ __html: body }}
      />
    );
  };
}

export const ActivityIcon = createSolarIcon(activity);
export const ArrowDownIcon = createSolarIcon(arrowDown);
export const ArrowDownToLineIcon = createSolarIcon(arrowDownToLine);
export const BrowserIcon = createSolarIcon(browser);
export const CalendarIcon = createSolarIcon(calendar);
export const ChartBarIcon = createSolarIcon(chartBar);
export const CheckIcon = createSolarIcon(check);
export const CheckCircleIcon = createSolarIcon(checkCircle);
export const ChecklistIcon = createSolarIcon(checklist);
export const ChecklistSelectedIcon = createSolarIcon(checklistSelected);
export const ChevronDownIcon = createSolarIcon(chevronDown);
export const ChevronLeftIcon = createSolarIcon(chevronLeft);
export const ChevronRightIcon = createSolarIcon(chevronRight);
export const ChevronUpIcon = createSolarIcon(chevronUp);
export const ChevronsLeftIcon = createSolarIcon(chevronsLeft);
export const ChevronsRightIcon = createSolarIcon(chevronsRight);
export const CircleIcon = createSolarIcon(circle);
export const CircleAlertIcon = createSolarIcon(circleAlert);
export const CircleDashedIcon = createSolarIcon(circleDashed);
export const CloseIcon = createSolarIcon(close);
export const CloudDownloadIcon = createSolarIcon(cloudDownload);
export const CloudUploadIcon = createSolarIcon(cloudUpload);
export const CopyIcon = createSolarIcon(copy);
export const DangerTriangleIcon = createSolarIcon(dangerTriangle);
export const DownloadIcon = createSolarIcon(download);
export const ErrorIcon = createSolarIcon(error);
export const ExternalLinkIcon = createSolarIcon(externalLink);
export const FileTextIcon = createSolarIcon(fileText);
export const FilterIcon = createSolarIcon(filter);
export const FineTuneIcon = createSolarIcon(fineTune);
export const FolderIcon = createSolarIcon(folder);
export const FolderOpenIcon = createSolarIcon(folderOpen);
export const GitBranchIcon = createSolarIcon(gitBranch);
export const GlobeIcon = createSolarIcon(globe);
export const HardDriveIcon = createSolarIcon(hardDrive);
export const InfoIcon = createSolarIcon(info);
export const ListIcon = createSolarIcon(list);
export const ListChecksIcon = createSolarIcon(listChecks);
export const LoaderIcon = createSolarIcon(loader);
export const MinusIcon = createSolarIcon(minus);
export const MoonIcon = createSolarIcon(moon);
export const MoreHorizontalIcon = createSolarIcon(moreHorizontal);
export const PanelLeftIcon = createSolarIcon(panelLeft);
export const PauseIcon = createSolarIcon(pause);
export const PlayIcon = createSolarIcon(play);
export const PowerIcon = createSolarIcon(power);
export const RefreshIcon = createSolarIcon(refresh);
export const RestartIcon = createSolarIcon(restart);
export const ScissorsIcon = createSolarIcon(scissors);
export const SearchIcon = createSolarIcon(search);
export const SettingsIcon = createSolarIcon(settings);
export const StopCircleIcon = createSolarIcon(stopCircle);
export const SunIcon = createSolarIcon(sun);
export const TerminalIcon = createSolarIcon(terminal);
export const TrashIcon = createSolarIcon(trash);
export const UndoIcon = createSolarIcon(undo);
export const UserSearchIcon = createSolarIcon(userSearch);
export const WrapTextIcon = createSolarIcon(wrapText);
