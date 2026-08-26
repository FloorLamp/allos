"use client";

import TabList from "@/components/TabList";
import UploadForm from "@/components/UploadForm";
import ImportClient from "@/components/ImportClient";

export default function ImportMethodTabs(props: {
  demo: boolean;
  weightUnit: "kg" | "lb";
  workoutImportAvailable: boolean;
}) {
  return (
    <TabList
      binding="button"
      ariaLabel="Import method"
      tabs={[
        { id: "upload", label: "File upload (incl. CSV)" },
        { id: "paste", label: "Paste CSV" },
      ]}
    >
      {(panels) =>
        panels.map((panel) => (
          <div
            key={panel.id}
            id={panel.panelId}
            role="tabpanel"
            aria-labelledby={panel.tabId}
            hidden={!panel.active}
            className="mt-4"
          >
            {panel.id === "upload" ? (
              <>
                <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                  Upload a lab report, scan, or health-record export
                </h2>
                <UploadForm demo={props.demo} />
              </>
            ) : (
              <ImportClient
                units={{ weightUnit: props.weightUnit }}
                workoutImportAvailable={props.workoutImportAvailable}
              />
            )}
          </div>
        ))
      }
    </TabList>
  );
}
