import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ru from './locales/ru.json';
import tr from './locales/tr.json';

// EN, RU and TR (the HQ's own language) are live. The remaining locales from
// docs/02-localization.md — uk, it, ro, uz, kk, ar — are added by dropping in another JSON file
// here; Arabic additionally needs dir="rtl", which the ui-kit already supports through logical
// CSS properties. ASSUMPTION: the mandatory language set is still unconfirmed (open question #3).
export const LANGUAGES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ru', label: 'Русский', dir: 'ltr' },
  { code: 'tr', label: 'Türkçe', dir: 'ltr' },
] as const;

const STORAGE_KEY = 'gsi.lang';

function initialLanguage(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = navigator.language?.slice(0, 2);
  return LANGUAGES.some((l) => l.code === nav) ? nav : 'en';
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ru: { translation: ru }, tr: { translation: tr } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

function applyDocumentLanguage(lng: string) {
  const lang = LANGUAGES.find((l) => l.code === lng);
  document.documentElement.lang = lng;
  // RTL is driven from here once Arabic is added; the ui-kit uses logical CSS properties.
  document.documentElement.dir = lang?.dir ?? 'ltr';
}

applyDocumentLanguage(i18n.language);
i18n.on('languageChanged', (lng) => {
  applyDocumentLanguage(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* ignore */
  }
});

/**
 * Switches to the language stored on the user's profile the first time they sign in on this
 * device (a Turkish surveyor gets a Turkish interface without touching the selector). An
 * explicit choice made in the app always wins — it is kept in localStorage.
 */
export function applyUserLocale(locale: string | undefined): void {
  if (!locale) return;
  try {
    if (localStorage.getItem(STORAGE_KEY)) return;
  } catch {
    /* storage unavailable — fall through and still honour the profile */
  }
  const code = locale.slice(0, 2);
  if (LANGUAGES.some((l) => l.code === code) && i18n.language !== code) {
    void i18n.changeLanguage(code);
    try {
      localStorage.removeItem(STORAGE_KEY); // profile default, not an explicit choice
    } catch {
      /* ignore */
    }
  }
}

export default i18n;
