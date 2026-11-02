"use client";
import {
  FAMILY_IMAGE_QUALITIES,
  FAMILY_IMAGE_SIZES,
  type FamilyImageOptions,
  type FamilyImageQuality,
  type FamilyImageSize,
} from "./image-types";
import styles from "./image-controls.module.scss";

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
        <label className={styles.field}>
          <span>图片比例</span>
          <select
            aria-label="图片比例"
            value={options.size}
            disabled={disabled}
            onChange={(event) => {
              const size = event.currentTarget.value;
              if (
                !disabled &&
                (FAMILY_IMAGE_SIZES as readonly string[]).includes(size)
              )
                onChange({ ...options, size: size as FamilyImageSize });
            }}
          >
            <option value="1024x1024">正方形 · 1:1</option>
            <option value="1536x1024">横图 · 3:2</option>
            <option value="1024x1536">竖图 · 2:3</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>图片质量</span>
          <select
            aria-label="图片质量"
            value={options.quality}
            disabled={disabled}
            onChange={(event) => {
              const quality = event.currentTarget.value;
              if (
                !disabled &&
                (FAMILY_IMAGE_QUALITIES as readonly string[]).includes(quality)
              )
                onChange({
                  ...options,
                  quality: quality as FamilyImageQuality,
                });
            }}
          >
            <option value="low">快速</option>
            <option value="medium">标准</option>
            <option value="high">精细</option>
          </select>
        </label>
      </div>
      <p className={styles.help}>
        每次生成 1 张，计入 API 额度。质量会影响耗时和消耗。
      </p>
    </section>
  );
}
