export interface Settings {
  readonly titleMode: "action" | "tool";
  readonly showDuration: boolean;
  readonly lineNumbers: boolean;
  readonly backdrop: boolean;
  readonly horizontalRules: "none" | "top" | "bottom" | "both";
  readonly resultRows: number | null;
  readonly shellWindow: "head" | "tail" | "head-tail";
  readonly commandPreview: boolean;
  readonly shellSourceInitiallyVisible: boolean;
  readonly codeInitiallyVisible: boolean;
  readonly diffMode: "native" | "unified" | "split" | "auto";
  readonly diffContext: number;
  readonly diffEmphasisGap: number;
  readonly diffRowBackground: boolean;
}

export type SettingsPatch = Partial<Settings>;
export type SettingsKey = keyof Settings;
export type SettingsTarget = "personal" | "project";

export const defaults: Settings = Object.freeze({
  titleMode: "action",
  showDuration: true,
  lineNumbers: true,
  backdrop: false,
  horizontalRules: "none",
  resultRows: 12,
  shellWindow: "head-tail",
  commandPreview: true,
  shellSourceInitiallyVisible: false,
  codeInitiallyVisible: false,
  diffMode: "auto",
  diffContext: 3,
  diffEmphasisGap: 2,
  diffRowBackground: false,
});

export const settingKeys = Object.keys(defaults) as SettingsKey[];

const alternatives: Partial<Record<SettingsKey, readonly Settings[SettingsKey][]>> = {
  titleMode: ["action", "tool"],
  horizontalRules: ["none", "top", "bottom", "both"],
  shellWindow: ["head", "tail", "head-tail"],
  diffMode: ["native", "unified", "split", "auto"],
};

export type SettingsValidation =
  | { readonly ok: true; readonly value: SettingsPatch }
  | { readonly ok: false; readonly message: string };

export function validateSettings(value: unknown): SettingsValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Settings must be a JSON object." };
  }

  const patch: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(defaults, key)) {
      return { ok: false, message: `Unknown setting: ${key}` };
    }

    const name = key as SettingsKey;
    const choices = alternatives[name];
    const valid = choices
      ? typeof field === "string" && choices.some(choice => choice === field)
      : name === "resultRows"
        ? field === null || (Number.isSafeInteger(field) && Number(field) >= 0)
        : name === "diffContext" || name === "diffEmphasisGap"
          ? Number.isSafeInteger(field) && Number(field) >= 0
          : typeof field === "boolean";

    if (!valid) return { ok: false, message: `Invalid value for ${key}.` };
    patch[key] = field;
  }

  return { ok: true, value: patch as SettingsPatch };
}

export function mergeSettings(personal: SettingsPatch, project: SettingsPatch): Settings {
  return { ...defaults, ...personal, ...project };
}

export function settingsChoices(key: SettingsKey): readonly (Settings[SettingsKey] | undefined)[] {
  if (key === "resultRows") return [undefined, 6, 12, 24, 48, null];
  if (key === "diffContext") return [undefined, 0, 1, 3, 5, 10];
  if (key === "diffEmphasisGap") return [undefined, 0, 1, 2, 3, 5];
  return [undefined, ...(alternatives[key] ?? [false, true])];
}
