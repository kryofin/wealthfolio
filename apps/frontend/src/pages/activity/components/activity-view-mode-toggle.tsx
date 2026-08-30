import { useTranslation } from "react-i18next";

import { AnimatedToggleGroup, Icons } from "@wealthfolio/ui";

import type { ActivityViewMode } from "./activity-view-controls";

interface ActivityViewModeToggleProps {
  viewMode: ActivityViewMode;
  onViewModeChange: (mode: ActivityViewMode) => void;
  className?: string;
}

/**
 * The view/edit switch, shared by both activity tabs. Extracted from
 * `ActivityViewControls` so the spending tab can offer the same control without
 * pulling in the investments filter bar.
 */
export function ActivityViewModeToggle({
  viewMode,
  onViewModeChange,
  className = "shrink-0",
}: ActivityViewModeToggleProps) {
  const { t } = useTranslation();

  return (
    <AnimatedToggleGroup
      value={viewMode}
      rounded="lg"
      size="sm"
      onValueChange={(value) => {
        if (value === "datagrid" || value === "table") {
          onViewModeChange(value);
        }
      }}
      className={className}
      items={[
        {
          value: "table",
          label: (
            <>
              <Icons.Rows3 className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{t("activity:view_mode")}</span>
            </>
          ),
          title: t("activity:view_mode"),
        },
        {
          value: "datagrid",
          label: (
            <>
              <Icons.Grid3x3 className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{t("activity:edit_mode")}</span>
            </>
          ),
          title: t("activity:edit_mode"),
          "data-testid": "edit-mode-toggle",
        },
      ]}
    />
  );
}
