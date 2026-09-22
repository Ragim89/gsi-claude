import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ru from './locales/ru.json';

// ASSUMPTION: the mandatory language set is not confirmed yet (open question #3). MVP-1 ships EN + RU;
// TR and the rest (docs/02-localization.md) are added in MVP-2 by dropping in more JSON files,
// moved into packages/i18n together with the shared glossary.
export const LANGUAGES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ru', label: 'Русский', dir: 'ltr' },
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
  resources: { en: { translation: en }, ru: { translation: ru } },
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

export default i18n;
