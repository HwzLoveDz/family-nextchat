"use client";

import {
  FAMILY_REASONING_EFFORTS,
  type FamilyReasoningEffort,
} from "./reasoning-types";
import styles from "./reasoning-effort-picker.module.scss";

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
    <label className={styles.control}>
      <span className={styles.srOnly}>推理强度</span>
      <select
        className={styles.select}
        aria-label="推理强度"
        title="推理强度"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (
            !disabled &&
            (FAMILY_REASONING_EFFORTS as readonly string[]).includes(next)
          )
            onChange(next as FamilyReasoningEffort);
        }}
      >
        <option value="low">轻度</option>
        <option value="medium">中等</option>
        <option value="high">高强度</option>
      </select>
    </label>
  );
}
