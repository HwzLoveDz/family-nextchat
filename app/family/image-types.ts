export const FAMILY_IMAGE_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
] as const;
export const FAMILY_IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type FamilyImageSize = (typeof FAMILY_IMAGE_SIZES)[number];
export type FamilyImageQuality = (typeof FAMILY_IMAGE_QUALITIES)[number];
export interface FamilyImageOptions {
  size: FamilyImageSize;
  quality: FamilyImageQuality;
}
export interface FamilyGeneratedImageMeta {
  id: string;
  name: string;
  mediaType: "image/jpeg";
  byteSize: number;
  width: number;
  height: number;
  model: string;
  createdAt: string;
}
export const DEFAULT_IMAGE_OPTIONS: FamilyImageOptions = {
  size: "1024x1024",
  quality: "medium",
};
