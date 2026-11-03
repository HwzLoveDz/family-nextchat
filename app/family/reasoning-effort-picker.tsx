"use client";

import {
  FAMILY_REASONING_EFFORTS,
  type FamilyReasoningEffort,
} from "./reasoning-types";
import styles from "./reasoning-effort-picker.module.scss";
import { WorkspaceSelect } from "./workspace-select";

export function ReasoningEffortPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: FamilyReasoningEffort;
  onChange: (value: FamilyReasoningEffort) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.control}>
      <WorkspaceSelect
        label="推理强度"
        value={value}
        disabled={disabled}
        width={174}
        options={[
          { value: "low", label: "轻度" },
          { value: "medium", label: "中等" },
          { value: "high", label: "高强度" },
        ]}
        onChange={(next) => {
          if (
            !disabled &&
            (FAMILY_REASONING_EFFORTS as readonly string[]).includes(next)
          )
            onChange(next as FamilyReasoningEffort);
        }}
      />
    </div>
  );
}
