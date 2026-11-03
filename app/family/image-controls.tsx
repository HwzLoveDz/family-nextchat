"use client";
import {
  FAMILY_IMAGE_QUALITIES,
  FAMILY_IMAGE_SIZES,
  type FamilyImageOptions,
  type FamilyImageQuality,
  type FamilyImageSize,
} from "./image-types";
import styles from "./image-controls.module.scss";
import { WorkspaceSelect } from "./workspace-select";

export interface ImageGenerationControlsProps {
  options: FamilyImageOptions;
  onChange: (options: FamilyImageOptions) => void;
  disabled: boolean;
}

export function ImageGenerationControls({
  options,
  onChange,
  disabled,
}: ImageGenerationControlsProps) {
  return (
    <section className={styles.controls} aria-label="图片生成设置">
      <div className={styles.row}>
        <div className={styles.field}>
          <span>图片比例</span>
          <WorkspaceSelect
            label="图片比例"
            variant="field"
            value={options.size}
            disabled={disabled}
            options={[
              { value: "1024x1024", label: "正方形 · 1:1" },
              { value: "1536x1024", label: "横图 · 3:2" },
              { value: "1024x1536", label: "竖图 · 2:3" },
            ]}
            onChange={(size) => {
              if (
                !disabled &&
                (FAMILY_IMAGE_SIZES as readonly string[]).includes(size)
              )
                onChange({ ...options, size: size as FamilyImageSize });
            }}
          />
        </div>
        <div className={styles.field}>
          <span>图片质量</span>
          <WorkspaceSelect
            label="图片质量"
            variant="field"
            value={options.quality}
            disabled={disabled}
            options={[
              { value: "low", label: "快速" },
              { value: "medium", label: "标准" },
              { value: "high", label: "精细" },
            ]}
            onChange={(quality) => {
              if (
                !disabled &&
                (FAMILY_IMAGE_QUALITIES as readonly string[]).includes(quality)
              )
                onChange({
                  ...options,
                  quality: quality as FamilyImageQuality,
                });
            }}
          />
        </div>
      </div>
      <p className={styles.help}>
        每次生成 1 张，计入 API 额度。质量会影响耗时和消耗。
      </p>
    </section>
  );
}
