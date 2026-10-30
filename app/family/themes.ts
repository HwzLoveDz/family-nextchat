/** Pure presentation metadata. Apply variables to a family surface, never :root. */
export const FAMILY_THEME_IDS = [
  "cream",
  "ocean",
  "lilac",
  "apricot",
  "midnight",
  "forest",
] as const;
export type FamilyThemeId = (typeof FAMILY_THEME_IDS)[number];
export const DEFAULT_FAMILY_THEME: FamilyThemeId = "cream";

// The original palette is explicit so the default retains every existing shade.
const CREAM_VARIABLES = {
  "--ink": "#253d38",
  "--muted": "#687a73",
  "--paper": "#fffefa",
  "--line": "#e3e9df",
  "--accent": "#316451",
  "--page": "#f2f4ed",
  "--on-accent": "#ffffff",
  "--accent-hover": "#244f40",
  "--input-line": "#cdd8cd",
  "--focus": "#6a9982",
  "--secondary-line": "#d8e1d5",
  "--hover": "#edf2e9",
  "--danger-bg": "#fff4f0",
  "--danger-line": "#edd1c6",
  "--danger-text": "#9b4032",
  "--danger-hover": "#f8e1da",
  "--auth-shadow": "#36583b0b",
  "--notice-bg": "#f4f6ee",
  "--notice-text": "#64735e",
  "--error-bg": "#fff1ed",
  "--error-text": "#963f32",
  "--success-bg": "#edf5e9",
  "--success-text": "#395f3c",
  "--frame-line": "#dce4d7",
  "--app-shadow": "#3c593913",
  "--panel-bg": "#f0f5e9",
  "--sidebar-bg": "#edf1e7",
  "--chat-hover": "#e2e9dc",
  "--chat-active-line": "#d9e2d1",
  "--account-line": "#dce4d5",
  "--soft-bg": "#edf3e5",
  "--panel-line": "#cbdcc1",
  "--user-bg": "#f0f4eb",
  "--user-line": "#e1e8d9",
  "--code-bg": "#eef1e9",
  "--inline-code-bg": "#edf0e6",
  "--link": "#356d58",
  "--quote-line": "#bccfba",
  "--icon-bg": "#e4eddd",
  "--composer-line": "#cbd8c6",
  "--composer-shadow": "#465b3a06",
  "--voice-bg": "#edf3e7",
  "--voice-recording-bg": "#e2edda",
  "--voice-recording-line": "#81a475",
  "--badge-bg": "#edf2e6",
  "--badge-text": "#647b58",
  "--backdrop": "#21352866",
  "--attachment-button-bg": "#eef3e8",
  "--attachment-button-line": "#d6e1cd",
  "--attachment-line": "#dde6d5",
  "--attachment-bg": "#f4f6ef",
  "--attachment-warning": "#876348",
  "--attachment-badge-bg": "#e8efdf",
  "--attachment-badge-text": "#607a50",
} as const;
export type FamilyThemeToken = keyof typeof CREAM_VARIABLES;
export type FamilyThemeVariables = Readonly<Record<FamilyThemeToken, string>>;
export interface FamilyTheme {
  readonly id: FamilyThemeId;
  readonly label: string;
  readonly description: string;
  readonly dark: boolean;
  readonly swatches: readonly string[];
  readonly variables: FamilyThemeVariables;
}

interface Palette {
  ink: string;
  muted: string;
  paper: string;
  page: string;
  line: string;
  accent: string;
  accentHover: string;
  onAccent: string;
  inputLine: string;
  focus: string;
  border: string;
  borderStrong: string;
  hover: string;
  panel: string;
  sidebar: string;
  soft: string;
  user: string;
  code: string;
  warning: string;
  shadow: string;
  backdrop: string;
  errorBg: string;
  errorText: string;
  errorBorder: string;
  errorHover: string;
  successBg: string;
  successText: string;
}
/** Every semantic token is assigned; darker surfaces cannot inherit cream shades. */
function paletteVariables(p: Palette): FamilyThemeVariables {
  return Object.freeze({
    "--ink": p.ink,
    "--muted": p.muted,
    "--paper": p.paper,
    "--line": p.line,
    "--accent": p.accent,
    "--page": p.page,
    "--on-accent": p.onAccent,
    "--accent-hover": p.accentHover,
    "--input-line": p.inputLine,
    "--focus": p.focus,
    "--secondary-line": p.border,
    "--hover": p.hover,
    "--danger-bg": p.errorBg,
    "--danger-line": p.errorBorder,
    "--danger-text": p.errorText,
    "--danger-hover": p.errorHover,
    "--auth-shadow": p.shadow,
    "--notice-bg": p.panel,
    "--notice-text": p.muted,
    "--error-bg": p.errorBg,
    "--error-text": p.errorText,
    "--success-bg": p.successBg,
    "--success-text": p.successText,
    "--frame-line": p.border,
    "--app-shadow": p.shadow,
    "--panel-bg": p.panel,
    "--sidebar-bg": p.sidebar,
    "--chat-hover": p.hover,
    "--chat-active-line": p.borderStrong,
    "--account-line": p.line,
    "--soft-bg": p.soft,
    "--panel-line": p.borderStrong,
    "--user-bg": p.user,
    "--user-line": p.line,
    "--code-bg": p.code,
    "--inline-code-bg": p.code,
    "--link": p.accent,
    "--quote-line": p.borderStrong,
    "--icon-bg": p.soft,
    "--composer-line": p.inputLine,
    "--composer-shadow": p.shadow,
    "--voice-bg": p.soft,
    "--voice-recording-bg": p.hover,
    "--voice-recording-line": p.focus,
    "--badge-bg": p.soft,
    "--badge-text": p.muted,
    "--backdrop": p.backdrop,
    "--attachment-button-bg": p.soft,
    "--attachment-button-line": p.borderStrong,
    "--attachment-line": p.line,
    "--attachment-bg": p.panel,
    "--attachment-warning": p.warning,
    "--attachment-badge-bg": p.hover,
    "--attachment-badge-text": p.accent,
  });
}
function theme(
  id: FamilyThemeId,
  label: string,
  description: string,
  dark: boolean,
  variables: FamilyThemeVariables,
): FamilyTheme {
  return Object.freeze({
    id,
    label,
    description,
    dark,
    variables: Object.freeze(variables),
    swatches: Object.freeze([
      variables["--page"],
      variables["--paper"],
      variables["--accent"],
    ]),
  });
}

export const FAMILY_THEMES: readonly FamilyTheme[] = Object.freeze([
  theme("cream", "奶油绿", "温暖纸色，柔和绿调", false, CREAM_VARIABLES),
  theme(
    "ocean",
    "海盐蓝",
    "清爽浅蓝，沉静海色",
    false,
    paletteVariables({
      ink: "#243d4a",
      muted: "#536975",
      paper: "#fcfefd",
      page: "#edf3f6",
      line: "#dae5e9",
      accent: "#2d647c",
      accentHover: "#214e64",
      onAccent: "#ffffff",
      inputLine: "#bdcfd9",
      focus: "#57899f",
      border: "#d0dfe5",
      borderStrong: "#b8cfda",
      hover: "#dfeaf0",
      panel: "#eef5f8",
      sidebar: "#e6eff3",
      soft: "#e8f1f6",
      user: "#eaf2f7",
      code: "#e6eef2",
      warning: "#826044",
      shadow: "#294b6012",
      backdrop: "#19354466",
      errorBg: "#fff1ee",
      errorText: "#993f36",
      errorBorder: "#e8c9c1",
      errorHover: "#f7e0da",
      successBg: "#eaf5f0",
      successText: "#35634f",
    }),
  ),
  theme(
    "lilac",
    "丁香紫",
    "柔和淡紫，轻盈安静",
    false,
    paletteVariables({
      ink: "#40354b",
      muted: "#6d5e77",
      paper: "#fffdfd",
      page: "#f3eff6",
      line: "#e5deeb",
      accent: "#73568b",
      accentHover: "#5b416f",
      onAccent: "#ffffff",
      inputLine: "#d1c2dc",
      focus: "#9876af",
      border: "#dfd4e7",
      borderStrong: "#cfbbdd",
      hover: "#e9e0f0",
      panel: "#f5eff8",
      sidebar: "#eee7f3",
      soft: "#f0e8f6",
      user: "#f1eaf7",
      code: "#eee6f3",
      warning: "#896042",
      shadow: "#50396012",
      backdrop: "#34243f66",
      errorBg: "#fff0ef",
      errorText: "#9b3c3c",
      errorBorder: "#ebc6c6",
      errorHover: "#f8dddd",
      successBg: "#edf5ec",
      successText: "#3b663f",
    }),
  ),
  theme(
    "apricot",
    "暖杏橙",
    "浅杏纸色，温暖橙调",
    false,
    paletteVariables({
      ink: "#4c382c",
      muted: "#756153",
      paper: "#fffdf9",
      page: "#f8f0e7",
      line: "#eadecf",
      accent: "#925538",
      accentHover: "#774029",
      onAccent: "#ffffff",
      inputLine: "#d9c6b4",
      focus: "#ab7955",
      border: "#e4d4c4",
      borderStrong: "#d7bda5",
      hover: "#f1e3d4",
      panel: "#faf1e7",
      sidebar: "#f3e8da",
      soft: "#f8ebdc",
      user: "#f8ecdd",
      code: "#f1e7da",
      warning: "#8a5935",
      shadow: "#63482b12",
      backdrop: "#47332166",
      errorBg: "#fff0ec",
      errorText: "#9d3d32",
      errorBorder: "#e9c5b9",
      errorHover: "#f7ddd4",
      successBg: "#eef4e8",
      successText: "#486039",
    }),
  ),
  theme(
    "midnight",
    "午夜灰",
    "深灰底色，低亮度阅读",
    true,
    paletteVariables({
      ink: "#e1e8ed",
      muted: "#a8b8c4",
      paper: "#202930",
      page: "#141c23",
      line: "#3b4954",
      accent: "#a8c5d8",
      accentHover: "#c5dce8",
      onAccent: "#17252e",
      inputLine: "#506473",
      focus: "#8cb9d1",
      border: "#40515d",
      borderStrong: "#5b7181",
      hover: "#354956",
      panel: "#283741",
      sidebar: "#1a252e",
      soft: "#2b3d49",
      user: "#2c3f4c",
      code: "#18232c",
      warning: "#d4b996",
      shadow: "#00000040",
      backdrop: "#03080db3",
      errorBg: "#412c2f",
      errorText: "#f3b9b0",
      errorBorder: "#76504d",
      errorHover: "#51363b",
      successBg: "#263e34",
      successText: "#afd5bd",
    }),
  ),
  theme(
    "forest",
    "深林绿",
    "深绿底色，柔和浅绿",
    true,
    paletteVariables({
      ink: "#e0e9df",
      muted: "#adbeaf",
      paper: "#202e27",
      page: "#142119",
      line: "#3b5142",
      accent: "#a4cba6",
      accentHover: "#c3dec1",
      onAccent: "#1c3021",
      inputLine: "#526e57",
      focus: "#94b993",
      border: "#425b49",
      borderStrong: "#5e7b60",
      hover: "#364f3a",
      panel: "#293c2e",
      sidebar: "#1a2a20",
      soft: "#2e4433",
      user: "#304935",
      code: "#18271e",
      warning: "#d9bf97",
      shadow: "#00000040",
      backdrop: "#030b05b3",
      errorBg: "#412c2b",
      errorText: "#efb8a8",
      errorBorder: "#775348",
      errorHover: "#503934",
      successBg: "#304733",
      successText: "#b9d7af",
    }),
  ),
]);

export function getFamilyTheme(value: unknown): FamilyTheme {
  return FAMILY_THEMES.find((theme) => theme.id === value) ?? FAMILY_THEMES[0];
}
