import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BUILTIN_LOCALES,
  buildExportedLocaleJson,
  EN_TRANSLATIONS,
  LocalePack,
  parseImportedLocaleJson,
  TranslationKey,
} from "./locales";
import { isTauriRuntime } from "../webFallback";

const STORAGE_USER_LOCALE = "shibanc-user-locale";
const STORAGE_CUSTOM_LOCALES = "shibanc-custom-locales";

function loadSavedCustomLocales(): LocalePack[] {
  try {
    const raw = localStorage.getItem(STORAGE_CUSTOM_LOCALES);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (it): it is LocalePack =>
          Boolean(
            it &&
              typeof it.code === "string" &&
              typeof it.name === "string" &&
              it.translations &&
              typeof it.translations === "object"
          )
      )
      .map((it) => ({
        code: it.code,
        name: it.name,
        shortLabel:
          typeof it.shortLabel === "string" && it.shortLabel.trim()
            ? it.shortLabel
            : it.code.slice(0, 4).toUpperCase(),
        builtin: false,
        translations: it.translations,
      }));
  } catch {
    return [];
  }
}

export type TranslateFn = (
  key: TranslationKey,
  vars?: Record<string, string | number>
) => string;

interface I18nContextValue {
  locale: string;
  activePack: LocalePack;
  locales: LocalePack[];
  t: TranslateFn;
  setLocale: (code: string) => void;
  exportCurrentLocale: () => { fileName: string; jsonText: string };
  importLocaleText: (
    rawText: string,
    fileName?: string
  ) => { pack: LocalePack; keyCount: number };
  removeCustomLocale: (code: string) => LocalePack | null;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectOsDefaultLocale(): string {
  try {
    const langs: string[] = [];
    if (typeof navigator !== "undefined") {
      if (navigator.languages && navigator.languages.length > 0) {
        langs.push(...navigator.languages);
      }
      if (navigator.language) {
        langs.push(navigator.language);
      }
    }
    if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
      const intlLoc = Intl.DateTimeFormat().resolvedOptions().locale;
      if (intlLoc) langs.push(intlLoc);
    }
    for (const raw of langs) {
      if (!raw) continue;
      const lower = raw.toLowerCase();
      if (lower.startsWith("zh")) {
        return "zh-CN";
      }
      if (lower.startsWith("en")) {
        return "en";
      }
    }
  } catch {
    // fallback to English
  }
  return "en";
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [customLocales, setCustomLocales] = useState<LocalePack[]>(() =>
    loadSavedCustomLocales()
  );

  // Follow OS language on startup unless user explicitly switched language in the menu
  const [locale, setLocaleState] = useState<string>(() => {
    const saved = localStorage.getItem(STORAGE_USER_LOCALE);
    return saved && saved.trim() ? saved : detectOsDefaultLocale();
  });

  // Also query native Win32/OS UI language in Tauri desktop runtime on startup
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_USER_LOCALE);
    if (saved && saved.trim()) return;
    if (!isTauriRuntime()) return;
    invoke<string>("get_system_locale")
      .then((osLoc) => {
        if (osLoc === "zh-CN" || osLoc === "en") {
          setLocaleState(osLoc);
        }
      })
      .catch(() => {});
  }, []);

  const locales = useMemo(
    () => [...BUILTIN_LOCALES, ...customLocales],
    [customLocales]
  );

  const activePack = useMemo(
    () => locales.find((l) => l.code === locale) ?? BUILTIN_LOCALES[0],
    [locales, locale]
  );

  const t: TranslateFn = useCallback(
    (key, vars) => {
      const template =
        activePack.translations[key] ?? EN_TRANSLATIONS[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (_, k: string) =>
        Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`
      );
    },
    [activePack]
  );

  useEffect(() => {
    document.documentElement.lang = activePack.code;
    const winTitle = t("app.windowTitle");
    document.title = winTitle;
    if (isTauriRuntime()) {
      getCurrentWindow()
        .setTitle(winTitle)
        .catch(() => {});
    }
  }, [activePack, t]);

  const setLocale = useCallback((code: string) => {
    localStorage.setItem(STORAGE_USER_LOCALE, code);
    setLocaleState(code);
  }, []);

  const exportCurrentLocale = useCallback(() => {
    const jsonText = buildExportedLocaleJson(activePack);
    const safeCode = activePack.code.replace(/[^a-zA-Z0-9_-]/g, "_");
    return {
      fileName: `shibanc-lang-${safeCode}.json`,
      jsonText,
    };
  }, [activePack]);

  const importLocaleText = useCallback(
    (rawText: string, fileName?: string) => {
      const result = parseImportedLocaleJson(rawText, fileName);
      setCustomLocales((prev) => {
        const filtered = prev.filter((item) => item.code !== result.pack.code);
        const next = [...filtered, result.pack];
        localStorage.setItem(STORAGE_CUSTOM_LOCALES, JSON.stringify(next));
        return next;
      });
      localStorage.setItem(STORAGE_USER_LOCALE, result.pack.code);
      setLocaleState(result.pack.code);
      return result;
    },
    []
  );

  const removeCustomLocale = useCallback(
    (code: string) => {
      let removed: LocalePack | null = null;
      setCustomLocales((prev) => {
        removed = prev.find((item) => item.code === code) ?? null;
        const next = prev.filter((item) => item.code !== code);
        localStorage.setItem(STORAGE_CUSTOM_LOCALES, JSON.stringify(next));
        return next;
      });
      setLocaleState((cur) => {
        if (cur === code) {
          const fallback = detectOsDefaultLocale();
          localStorage.removeItem(STORAGE_USER_LOCALE);
          return fallback;
        }
        return cur;
      });
      return removed;
    },
    []
  );

  const ctxVal = useMemo<I18nContextValue>(
    () => ({
      locale: activePack.code,
      activePack,
      locales,
      t,
      setLocale,
      exportCurrentLocale,
      importLocaleText,
      removeCustomLocale,
    }),
    [
      activePack,
      locales,
      t,
      setLocale,
      exportCurrentLocale,
      importLocaleText,
      removeCustomLocale,
    ]
  );

  return <I18nContext.Provider value={ctxVal}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}
