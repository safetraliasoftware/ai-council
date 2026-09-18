import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import de from './locales/de.json'
import en from './locales/en.json'
import fr from './locales/fr.json'
import es from './locales/es.json'

// 'de' matches the app's original, only language - an unset persisted
// preference (or a renderer that hasn't yet asked the main process) must
// behave exactly like before this setting existed.
export const i18nReady = i18n.use(initReactI18next).init({
  resources: { de: { translation: de }, en: { translation: en }, fr: { translation: fr }, es: { translation: es } },
  lng: 'de',
  fallbackLng: 'de',
  interpolation: { escapeValue: false }
})

export default i18n
